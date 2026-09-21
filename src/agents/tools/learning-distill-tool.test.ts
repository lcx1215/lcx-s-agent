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
