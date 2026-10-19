import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "./common.js";
import {
  createLearningDistillTool,
  LEARNING_DISTILL_SCHEMA_VERSION,
  LEARNING_WORKFLOW_LATEST_FILENAME,
  type LearningWorkflowState,
} from "./learning-distill-tool.js";

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function storeRoot(): Promise<{ memoryDir: string; stateDir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "learning-distill-"));
  directories.push(root);
  const memoryDir = path.join(root, "memory");
  await fs.mkdir(memoryDir, { recursive: true });
  const stateDir = path.join(root, "state");
  await fs.mkdir(stateDir, { recursive: true });
  return { memoryDir, stateDir };
}

function reviewNote(
  fileDate: string,
  overrides: { sessionKey?: string; topic?: string } = {},
): string {
  const { topic = "fundamental-reading-and-risk", sessionKey = "sk-abc" } = overrides;
  return [
    `# Learning Review: ${fileDate} 12:00:00 UTC`,
    "",
    `- **Session Key**: ${sessionKey}`,
    `- **Session ID**: sid-1`,
    `- **Topic**: ${topic}`,
    "",
    "## Problem",
    "- a study-heavy session",
    "",
    "## Working Answer",
    "- a working answer",
    "",
    "## Review Note",
    "- mistake_pattern: a mistake",
    "- core_principle: a principle",
    "- micro_drill: a drill",
    "- transfer_hint: a transfer",
    "",
    "## Lobster Transfer",
    "- foundation_template: outcome-review",
    "- why_it_matters: compress this lesson",
    "",
    "## Session Trace",
    "- user: x",
    "",
  ].join("\n");
}

async function writeNote(
  dir: string,
  fileDate: string,
  name: string,
  overrides = {},
): Promise<void> {
  await fs.writeFile(path.join(dir, `${fileDate}-${name}.md`), reviewNote(fileDate, overrides));
}

type Payload = {
  ok: boolean;
  status?: string;
  reason?: string;
  cards?: unknown[];
  unparsed?: unknown[];
};

async function run(
  tool: AnyAgentTool,
  memoryDir: string,
  stateDir: string,
  extra: Record<string, unknown> = {},
): Promise<Payload> {
  const result = await tool.execute("learning-distill-test", {
    memoryDir,
    stateDir,
    windowDays: 366,
    ...extra,
  });
  return result.details as Payload;
}

describe("learning_distill", () => {
  it("reports an absent memory tree as a named failure, not an empty queue", async () => {
    const { stateDir } = await storeRoot();
    const tool = createLearningDistillTool({ workspaceDir: path.dirname(stateDir) });
    const payload = await run(
      tool,
      path.join(path.dirname(stateDir), "memory", "no-such-memory"),
      stateDir,
    );
    expect(payload.ok).toBe(false);
    expect(payload.status).toBe("absent");
    expect(payload.reason).toBe("learning_distill_memory_absent");
  });

  it("distills pending review notes into deterministic cards and writes the state surface", async () => {
    const { memoryDir, stateDir } = await storeRoot();
    await writeNote(memoryDir, "2026-09-10", "review-topic-a");
    await writeNote(memoryDir, "2026-09-11", "review-topic-b", {
      topic: "strategy-audit-and-overfit",
    });
    const tool = createLearningDistillTool({ workspaceDir: path.dirname(stateDir) });
    const payload = await run(tool, memoryDir, stateDir);

    expect(payload.ok).toBe(true);
    expect(payload.status).toBe("distilled");
    expect(payload.cards).toHaveLength(2);
    const cards = payload.cards as Array<Record<string, unknown>>;
    for (const card of cards) {
      // Derived fields are deterministic across runs: the note's own topic drives
      // the hints and foundation it would be given anyway.
      expect(typeof card.foundationTemplate).toBe("string");
      expect((card.foundationTemplate as string).length).toBeGreaterThan(0);
      expect((card.nextEval as string).length).toBeGreaterThan(0);
      expect(card.replay).toBe(false);
    }

    const surface = JSON.parse(
      await fs.readFile(path.join(stateDir, LEARNING_WORKFLOW_LATEST_FILENAME), "utf8"),
    ) as LearningWorkflowState;
    expect(surface.schemaVersion).toBe(LEARNING_DISTILL_SCHEMA_VERSION);
    expect(surface.scanned).toBe(2);
    expect(surface.pending).toBe(2);
    expect(surface.summary.keep).toBe(2);
    expect(surface.done).toHaveLength(2);
    expect(surface.processed).toHaveLength(2);
    // Per-run immutable snapshot is written before the pointer, so a crashed run
    // leaves the prior pointer untouched.
    expect(surface.latestRunPath).toContain(path.join("learning-workflow", "runs"));
    await expect(fs.access(surface.latestRunPath)).resolves.toBeUndefined();
  });

  it("is idempotent: a second run over the same notes distills nothing new", async () => {
    const { memoryDir, stateDir } = await storeRoot();
    await writeNote(memoryDir, "2026-09-10", "review-topic-a");
    const tool = createLearningDistillTool({ workspaceDir: path.dirname(stateDir) });
    expect((await run(tool, memoryDir, stateDir)).status).toBe("distilled");

    const second = await run(tool, memoryDir, stateDir);
    expect(second.ok).toBe(true);
    expect(second.status).toBe("no_pending_learning_items");
    expect(second.cards).toHaveLength(0);

    // A genuinely new note is picked up even after the earlier pass.
    await writeNote(memoryDir, "2026-09-12", "review-topic-c", { topic: "quant-modeling" });
    const third = await run(tool, memoryDir, stateDir);
    expect(third.status).toBe("distilled");
    expect(third.cards).toHaveLength(1);
  });

  it("flags a lesson that repeats across sessions as replay", async () => {
    const { memoryDir, stateDir } = await storeRoot();
    await writeNote(memoryDir, "2026-09-10", "review-repeat-1", { sessionKey: "sk-same" });
    await writeNote(memoryDir, "2026-09-11", "review-repeat-2", {
      sessionKey: "sk-same",
      topic: "fundamental-reading-and-risk",
    });
    const tool = createLearningDistillTool({ workspaceDir: path.dirname(stateDir) });
    const payload = await run(tool, memoryDir, stateDir);
    const cards = payload.cards as Array<{ replay: boolean }>;
    expect(cards).toHaveLength(2);
    expect(cards.every((card) => card.replay)).toBe(true);
  });

  it("never distills a note that lacks a topic; it names the gap instead", async () => {
    const { memoryDir, stateDir } = await storeRoot();
    await fs.writeFile(
      path.join(memoryDir, "2026-09-10-review-no-topic.md"),
      "# Learning Review: 2026-09-10 12:00:00 UTC\n- **Session Key**: sk-x\n## Review Note\n- core_principle: x\n",
    );
    const tool = createLearningDistillTool({ workspaceDir: path.dirname(stateDir) });
    const payload = await run(tool, memoryDir, stateDir);
    expect(payload.ok).toBe(true);
    expect(payload.cards).toHaveLength(0);
    expect(payload.unparsed).toEqual([
      { name: "2026-09-10-review-no-topic.md", reason: "learning_review_topic_missing" },
    ]);
  });
});

describe("learning_distill path boundary", () => {
  it("stops before output writes when cancelled during source reads", async () => {
    const { stateDir } = await storeRoot();
    const controller = new AbortController();
    vi.spyOn(fs, "readdir").mockImplementationOnce(async () => {
      controller.abort(new Error("cancel during read"));
      return [];
    });
    const tool = createLearningDistillTool({ workspaceDir: path.dirname(stateDir) });
    await expect(tool.execute("cancelled", {}, controller.signal)).rejects.toThrow(
      "cancel during read",
    );
    expect(await fs.readdir(stateDir)).toEqual([]);
  });

  it.each(["memoryDir", "stateDir"])("rejects model redirection of %s", async (key) => {
    const { memoryDir, stateDir } = await storeRoot();
    const outside = await storeRoot();
    const tool = createLearningDistillTool({ workspaceDir: path.dirname(stateDir) });
    await expect(run(tool, memoryDir, stateDir, { [key]: outside.memoryDir })).rejects.toThrow(
      /inside workspace/,
    );
    expect(await fs.readdir(outside.memoryDir)).toEqual([]);
    expect(await fs.readdir(stateDir)).toEqual([]);
  });

  it.each([
    "state",
    "state/learning-workflow",
    "state/learning-workflow/runs",
    "state/lcx-learning-workflow-latest.json",
    "memory",
  ])("rejects symlink escape at %s before writing any output", async (relative) => {
    const { memoryDir, stateDir } = await storeRoot();
    const root = path.dirname(stateDir);
    const outside = await storeRoot();
    const target = path.join(root, relative);
    const isFile = relative.endsWith(".json");
    const destination = isFile ? path.join(outside.stateDir, "sentinel.json") : outside.stateDir;
    if (isFile) {
      await fs.writeFile(destination, "unchanged");
    }
    if (relative === "memory" || relative === "state") {
      await fs.rmdir(target);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(destination, target);
    const tool = createLearningDistillTool({ workspaceDir: root });
    await expect(run(tool, memoryDir, stateDir)).rejects.toThrow(/escape|outside/);
    expect(await fs.readdir(outside.stateDir)).toEqual(isFile ? ["sentinel.json"] : []);
    if (isFile) {
      expect(await fs.readFile(destination, "utf8")).toBe("unchanged");
    }
    if (relative === "state/lcx-learning-workflow-latest.json") {
      await expect(fs.access(path.join(stateDir, "learning-workflow", "runs"))).rejects.toThrow();
    } else if (relative !== "state") {
      await expect(
        fs.access(path.join(stateDir, LEARNING_WORKFLOW_LATEST_FILENAME)),
      ).rejects.toThrow();
    }
  });

  it("rejects an existing hardlinked latest pointer before creating a run", async () => {
    const { memoryDir, stateDir } = await storeRoot();
    const outside = await storeRoot();
    const original = path.join(outside.stateDir, "sentinel.json");
    await fs.writeFile(original, "unchanged");
    await fs.link(original, path.join(stateDir, LEARNING_WORKFLOW_LATEST_FILENAME));
    const tool = createLearningDistillTool({ workspaceDir: path.dirname(stateDir) });
    await expect(run(tool, memoryDir, stateDir)).rejects.toThrow(/hardlink/i);
    expect(await fs.readFile(original, "utf8")).toBe("unchanged");
    expect(await fs.readdir(stateDir)).toEqual([LEARNING_WORKFLOW_LATEST_FILENAME]);
  });

  it("rejects a state alias into protected memory inside the same workspace", async () => {
    const { memoryDir, stateDir } = await storeRoot();
    await fs.rmdir(stateDir);
    await fs.symlink(memoryDir, stateDir);
    const tool = createLearningDistillTool({ workspaceDir: path.dirname(stateDir) });
    await expect(run(tool, memoryDir, stateDir)).rejects.toThrow(/escapes workspace state/);
    expect(await fs.readdir(memoryDir)).toEqual([]);
  });

  it("allows a trusted workspace alias and creates its missing state tree", async () => {
    const { memoryDir, stateDir } = await storeRoot();
    await fs.rmdir(stateDir);
    const root = path.dirname(stateDir);
    const aliasParent = await storeRoot();
    const alias = path.join(aliasParent.stateDir, "workspace");
    await fs.symlink(root, alias);
    const tool = createLearningDistillTool({ workspaceDir: alias });
    const result = await tool.execute("alias", {});
    expect(result.details).toMatchObject({ ok: true });
    await expect(
      fs.access(path.join(stateDir, LEARNING_WORKFLOW_LATEST_FILENAME)),
    ).resolves.toBeUndefined();
    expect(await fs.readdir(memoryDir)).toEqual([]);
  });
});

describe("learning_distill scoped retained-card read", () => {
  it("retains a lesson across an empty pending pass and a new instance without writing or reinterpreting it", async () => {
    const { memoryDir, stateDir } = await storeRoot();
    const name = "2026-09-10-review-topic-a.md";
    await writeNote(memoryDir, "2026-09-10", "review-topic-a");
    const tool = createLearningDistillTool({ workspaceDir: path.dirname(stateDir) });
    await run(tool, memoryDir, stateDir);
    const notePath = path.join(memoryDir, name);
    await fs.writeFile(
      notePath,
      reviewNote("2026-09-10").replace("a principle", "changed principle"),
    );
    expect((await run(tool, memoryDir, stateDir)).cards).toEqual([]);
    const latest = path.join(stateDir, LEARNING_WORKFLOW_LATEST_FILENAME);
    const bytes = await fs.readFile(latest);
    const names = await fs.readdir(path.join(stateDir, "learning-workflow", "runs"));
    const noteBytes = await fs.readFile(notePath);
    const reader = createLearningDistillTool({ workspaceDir: path.dirname(stateDir) });
    const result = await reader.execute("read", { action: "read", cardName: name });
    expect(result.details).toMatchObject({
      ok: true,
      status: "read",
      corePrinciple: "a principle",
      cardDate: "2026-09-10",
      sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(await fs.readFile(latest)).toEqual(bytes);
    expect(await fs.readFile(notePath)).toEqual(noteBytes);
    expect(await fs.readdir(path.join(stateDir, "learning-workflow", "runs"))).toEqual(names);
  });

  it("retains distinct literal session methods, their source hashes, and explicit UTF-8 truncation", async () => {
    const { memoryDir, stateDir } = await storeRoot();
    const tool = createLearningDistillTool({ workspaceDir: path.dirname(stateDir) });
    const sourceA = reviewNote("2026-09-10").replace(
      "- a working answer",
      "- Divide measured latency by requests; use beta, never task labels.",
    );
    const sourceB = reviewNote("2026-09-11").replace(
      "- a working answer",
      "- Reject data beyond cutoff; compare only matched inputs.",
    );
    await fs.writeFile(path.join(memoryDir, "2026-09-10-review-a.md"), sourceA);
    await fs.writeFile(path.join(memoryDir, "2026-09-11-review-b.md"), sourceB);
    await run(tool, memoryDir, stateDir);
    await run(tool, memoryDir, stateDir);
    const state = JSON.parse(
      await fs.readFile(path.join(stateDir, LEARNING_WORKFLOW_LATEST_FILENAME), "utf8"),
    ) as LearningWorkflowState;
    expect(state.retainedCards?.[0].sourceNoteSha256).toBe(
      createHash("sha256").update(sourceA).digest("hex"),
    );
    expect(state.retainedCards?.[0].problem).toBe("- a study-heavy session");
    const reader = createLearningDistillTool({ workspaceDir: path.dirname(stateDir) });
    const a = await reader.execute("read-a", {
      action: "read",
      cardName: "2026-09-10-review-a.md",
      field: "workingAnswer",
    });
    const b = await reader.execute("read-b", {
      action: "read",
      cardName: "2026-09-11-review-b.md",
      field: "workingAnswer",
    });
    expect(a.details).toMatchObject({
      workingAnswer: "- Divide measured latency by requests; use beta, never task labels.",
      truncated: false,
      retained_source_not_validated_skill: true,
    });
    expect(b.details).toMatchObject({
      workingAnswer: "- Reject data beyond cutoff; compare only matched inputs.",
      truncated: false,
    });
    const long = reviewNote("2026-09-12").replace("- a working answer", "数".repeat(800));
    await fs.writeFile(path.join(memoryDir, "2026-09-12-review-long.md"), long);
    await run(tool, memoryDir, stateDir);
    const clipped = (
      await reader.execute("read", {
        action: "read",
        cardName: "2026-09-12-review-long.md",
        field: "workingAnswer",
      })
    ).details as Record<string, unknown>;
    expect(clipped.truncated).toBe(true);
    expect(Buffer.byteLength(String(clipped.workingAnswer))).toBeLessThanOrEqual(160);
    expect(String(clipped.workingAnswer)).not.toContain("�");
  });

  it("reads legacy current cards but names a missing legacy card rather than reconstructing memory", async () => {
    const { memoryDir, stateDir } = await storeRoot();
    await writeNote(memoryDir, "2026-09-10", "review-topic-a");
    const tool = createLearningDistillTool({ workspaceDir: path.dirname(stateDir) });
    await run(tool, memoryDir, stateDir);
    const latest = path.join(stateDir, LEARNING_WORKFLOW_LATEST_FILENAME);
    const state = JSON.parse(await fs.readFile(latest, "utf8"));
    delete state.retainedCards;
    await fs.writeFile(latest, JSON.stringify(state));
    expect(
      (await tool.execute("read", { action: "read", cardName: state.cards[0].name })).details,
    ).toMatchObject({ ok: true });
    await expect(
      tool.execute("read", {
        action: "read",
        cardName: state.cards[0].name,
        field: "workingAnswer",
      }),
    ).resolves.toMatchObject({ details: { ok: true } });
    delete state.cards[0].workingAnswer;
    await fs.writeFile(latest, JSON.stringify(state));
    expect(
      (
        await tool.execute("read", {
          action: "read",
          cardName: state.cards[0].name,
          field: "workingAnswer",
        })
      ).details,
    ).toMatchObject({ ok: false, status: "unknown", reason: "learning_card_field_not_retained" });
    state.cards = [];
    await fs.writeFile(latest, JSON.stringify(state));
    expect(
      (await tool.execute("read", { action: "read", cardName: state.processed[0].name })).details,
    ).toMatchObject({ ok: false, status: "unknown", reason: "learning_card_not_retained" });
  });

  it.each(["../2026-09-10-review-x.md", "2026-09-10-review-/x.md", "anything.md", ""])(
    "rejects non-exact card name %s without creating state",
    async (cardName) => {
      const { stateDir } = await storeRoot();
      const tool = createLearningDistillTool({ workspaceDir: path.dirname(stateDir) });
      expect((await tool.execute("read", { action: "read", cardName })).details).toMatchObject({
        ok: false,
        reason: "learning_card_name_invalid",
      });
      expect(await fs.readdir(stateDir)).toEqual([]);
    },
  );

  it.each(["absent", "invalid", "oversized"])(
    "reports %s surface as unknown without writes",
    async (kind) => {
      const { stateDir } = await storeRoot();
      const latest = path.join(stateDir, LEARNING_WORKFLOW_LATEST_FILENAME);
      if (kind !== "absent") {
        await fs.writeFile(
          latest,
          kind === "invalid"
            ? '{"schemaVersion":"lcx_learning_workflow_v1","processed":[null]}'
            : "x".repeat(4 * 1024 * 1024 + 1),
        );
      }
      const before = kind !== "absent" ? await fs.readFile(latest) : undefined;
      const tool = createLearningDistillTool({ workspaceDir: path.dirname(stateDir) });
      expect(
        (await tool.execute("read", { action: "read", cardName: "2026-09-10-review-x.md" }))
          .details,
      ).toMatchObject({ ok: false, status: "unknown" });
      if (before) {
        expect(await fs.readFile(latest)).toEqual(before);
      } else {
        expect(await fs.readdir(stateDir)).toEqual([]);
      }
    },
  );

  it("rejects read pointer alias escapes and cancelled reads", async () => {
    const { stateDir } = await storeRoot();
    const outside = await storeRoot();
    const sentinel = path.join(outside.stateDir, "sentinel.json");
    await fs.writeFile(sentinel, "unchanged");
    await fs.symlink(sentinel, path.join(stateDir, LEARNING_WORKFLOW_LATEST_FILENAME));
    const tool = createLearningDistillTool({ workspaceDir: path.dirname(stateDir) });
    await expect(
      tool.execute("read", { action: "read", cardName: "2026-09-10-review-x.md" }),
    ).rejects.toThrow(/escape|outside/);
    const controller = new AbortController();
    controller.abort(new Error("read cancelled"));
    await expect(
      tool.execute(
        "read",
        { action: "read", cardName: "2026-09-10-review-x.md" },
        controller.signal,
      ),
    ).rejects.toThrow("read cancelled");
    expect(await fs.readFile(sentinel, "utf8")).toBe("unchanged");
  });
});

describe("learning_distill independent note reads", () => {
  async function refuseOpen(notePath: string) {
    const canonicalPath = await fs.realpath(notePath);
    const original = fs.open.bind(fs);
    return vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      if (String(file) === canonicalPath) {
        throw new Error("untrusted file failure text must not be echoed");
      }
      return original(file, flags, mode);
    });
  }

  it("filters unrelated Markdown before attempting to read it", async () => {
    const { memoryDir, stateDir } = await storeRoot();
    await writeNote(memoryDir, "2026-09-10", "review-good");
    const unrelated = path.join(memoryDir, "unrelated.md");
    await fs.writeFile(unrelated, "Not a learning note.");
    const opens = await refuseOpen(unrelated);
    const tool = createLearningDistillTool({ workspaceDir: path.dirname(stateDir) });
    expect(await run(tool, memoryDir, stateDir)).toMatchObject({
      ok: true,
      status: "distilled",
      scanned: 1,
      sourceStatus: "complete",
    });
    expect(opens.mock.calls.some(([file]) => String(file).endsWith("/unrelated.md"))).toBe(false);
  });

  it("retains a readable note, names one failed source, and retries it on the next run", async () => {
    const { memoryDir, stateDir } = await storeRoot();
    const good = "2026-09-10-review-good.md";
    const failed = "2026-09-11-review-failed.md";
    await fs.writeFile(path.join(memoryDir, good), reviewNote("2026-09-10"));
    await fs.writeFile(path.join(memoryDir, failed), reviewNote("2026-09-11"));
    const sourceBytes = await fs.readFile(path.join(memoryDir, failed));
    const opens = await refuseOpen(path.join(memoryDir, failed));
    const tool = createLearningDistillTool({ workspaceDir: path.dirname(stateDir) });
    const result = await run(tool, memoryDir, stateDir);
    expect(result).toMatchObject({
      ok: true,
      status: "distilled",
      scanned: 2,
      sourceStatus: "partial",
      unparsed: [{ name: failed, reason: "learning_review_note_unreadable" }],
      cards: [expect.objectContaining({ name: good })],
    });
    const latest = path.join(stateDir, LEARNING_WORKFLOW_LATEST_FILENAME);
    const state = JSON.parse(await fs.readFile(latest, "utf8"));
    expect(state.sourceStatus).toBe("partial");
    expect(state.done).toEqual([good]);
    expect(state.processed).toEqual([expect.objectContaining({ name: good })]);
    expect((await tool.execute("read", { action: "read", cardName: good })).details).toMatchObject({
      ok: true,
      corePrinciple: "a principle",
    });
    opens.mockRestore();
    expect(await run(tool, memoryDir, stateDir)).toMatchObject({
      ok: true,
      sourceStatus: "complete",
      alreadyProcessed: 1,
      cards: [expect.objectContaining({ name: failed })],
    });
    expect(await fs.readFile(path.join(memoryDir, failed))).toEqual(sourceBytes);
  });

  it("keeps the last readable state when every matching source fails to read", async () => {
    const { memoryDir, stateDir } = await storeRoot();
    const name = "2026-09-10-review-prior.md";
    await fs.writeFile(path.join(memoryDir, name), reviewNote("2026-09-10"));
    const tool = createLearningDistillTool({ workspaceDir: path.dirname(stateDir) });
    await run(tool, memoryDir, stateDir);
    const latest = path.join(stateDir, LEARNING_WORKFLOW_LATEST_FILENAME);
    const before = await fs.readFile(latest);
    const runsDir = path.join(stateDir, "learning-workflow", "runs");
    const runs = await fs.readdir(runsDir);
    await refuseOpen(path.join(memoryDir, name));
    expect(await run(tool, memoryDir, stateDir)).toMatchObject({
      ok: false,
      status: "unreadable",
      sourceStatus: "unavailable",
      scanned: 1,
      reason: "learning_distill_memory_unreadable",
      unparsed: [{ name, reason: "learning_review_note_unreadable" }],
    });
    expect(await fs.readFile(latest)).toEqual(before);
    expect(await fs.readdir(runsDir)).toEqual(runs);
  });
});

describe("learning_distill writer-reader contract", () => {
  it("names an oversized card before it can enter the pending queue", async () => {
    const { memoryDir, stateDir } = await storeRoot();
    const name = "2026-09-10-review-oversized-field.md";
    const source = reviewNote("2026-09-10").replace("a principle", "x".repeat(16385));
    await fs.writeFile(path.join(memoryDir, name), source);
    const tool = createLearningDistillTool({ workspaceDir: path.dirname(stateDir) });
    const result = await run(tool, memoryDir, stateDir);
    expect(result).toMatchObject({
      ok: true,
      status: "no_pending_learning_items",
      cards: [],
      unparsed: [{ name, reason: "learning_distill_card_invalid" }],
    });
    const state = JSON.parse(
      await fs.readFile(path.join(stateDir, LEARNING_WORKFLOW_LATEST_FILENAME), "utf8"),
    ) as LearningWorkflowState;
    expect(state.processed).toEqual([]);
    expect(state.retainedCards).toEqual([]);
    expect(await fs.readFile(path.join(memoryDir, name), "utf8")).toBe(source);
  });

  it("refuses an aggregate surface over the reader limit before either snapshot write", async () => {
    const { memoryDir, stateDir } = await storeRoot();
    await writeNote(memoryDir, "2026-09-10", "review-prior");
    const tool = createLearningDistillTool({ workspaceDir: path.dirname(stateDir) });
    await run(tool, memoryDir, stateDir);
    const latest = path.join(stateDir, LEARNING_WORKFLOW_LATEST_FILENAME);
    const before = await fs.readFile(latest);
    const runsDir = path.join(stateDir, "learning-workflow", "runs");
    const beforeRuns = await fs.readdir(runsDir);
    const source = reviewNote("2026-09-11").replace("a principle", "x".repeat(16384));
    await Promise.all(
      Array.from({ length: 130 }, (_, index) =>
        fs.writeFile(path.join(memoryDir, `2026-09-11-review-budget-${index}.md`), source),
      ),
    );
    const result = await run(tool, memoryDir, stateDir);
    expect(result).toMatchObject({
      ok: false,
      status: "not_written",
      reason: "learning_workflow_state_too_large",
      unparsed: [
        { name: LEARNING_WORKFLOW_LATEST_FILENAME, reason: "learning_workflow_state_too_large" },
      ],
    });
    expect(await fs.readFile(latest)).toEqual(before);
    expect(await fs.readdir(runsDir)).toEqual(beforeRuns);
    expect(
      (await tool.execute("read", { action: "read", cardName: "2026-09-10-review-prior.md" }))
        .details,
    ).toMatchObject({ ok: true, corePrinciple: "a principle" });
    expect(await fs.readFile(path.join(memoryDir, "2026-09-11-review-budget-0.md"), "utf8")).toBe(
      source,
    );
  });
});
