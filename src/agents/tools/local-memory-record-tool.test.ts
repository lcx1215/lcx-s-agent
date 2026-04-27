import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { createLocalMemoryRecordTool } from "./local-memory-record-tool.js";

describe("local_memory_record tool", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  it("creates a bounded local durable-memory card", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-local-memory-");
    const tool = createLocalMemoryRecordTool({ workspaceDir });

    const result = await tool.execute("memory-create", {
      subject: "Holdings thesis revalidation",
      memoryType: "holding",
      summary: "Always retrieve the old thesis before giving any fresh hold/add/reduce stance.",
      activationRule:
        "Use when the user asks whether an old holding thesis still stands or when a fresh stance risks ignoring prior reasoning.",
      firstStep:
        "Pull the prior thesis, current anchor, latest carryover cue, and correction trail before forming any new stance.",
      stopRule:
        "Stop once the answer is bounded to what still holds, what broke, and one next judgment instead of broad market storytelling.",
      whyItMatters: "This prevents fresh-stance drift.",
      evidence: "Observed repeatedly in control-room hardening work.",
      sourceArtifact: "memory/current-research-line.md",
    });
    const details = result.details as {
      ok: boolean;
      created: boolean;
      updated: boolean;
      path: string;
      revision: number;
      memoryType: string;
    };

    expect(details.ok).toBe(true);
    expect(details.created).toBe(true);
    expect(details.updated).toBe(false);
    expect(details.path).toBe("memory/local-memory/holding-holdings-thesis-revalidation.md");
    expect(details.revision).toBe(1);
    expect(details.memoryType).toBe("holding");

    const content = await fs.readFile(path.join(workspaceDir, details.path), "utf8");
    expect(content).toContain("- subject: Holdings thesis revalidation");
    expect(content).toContain("- promotion_status: local_durable_memory_only");
    expect(content).toContain("## Current Summary");
    expect(content).toContain(
      "Always retrieve the old thesis before giving any fresh hold/add/reduce stance.",
    );
    expect(content).toContain("## Use This Card When");
    expect(content).toContain("## First Narrowing Step");
    expect(content).toContain("## Stop Rule");
    expect(content).toContain("## Prior Snapshots");
    expect(content).toContain("No prior snapshots yet.");
  });

  it("updates the same card and preserves prior snapshots instead of erasing old memory", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-local-memory-");
    const tool = createLocalMemoryRecordTool({ workspaceDir });

    await tool.execute("memory-first", {
      subject: "Holdings thesis revalidation",
      memoryType: "holding",
      summary: "Retrieve the old thesis first.",
      updateReason: "initial capture",
    });
    const second = await tool.execute("memory-second", {
      subject: "Holdings thesis revalidation",
      memoryType: "holding",
      summary:
        "Retrieve the old thesis, carryover cue, and correction trail before giving a fresh stance.",
      activationRule:
        "Use when the operator asks if the old thesis still holds or when a fresh answer risks ignoring the prior position logic.",
      firstStep:
        "Narrow first on the old thesis, the live carryover cue, and any correction note before adding fresh market color.",
      updateReason: "tightened the rule after more finance revalidation hardening",
    });
    const details = second.details as {
      ok: boolean;
      created: boolean;
      updated: boolean;
      path: string;
      revision: number;
    };

    expect(details.ok).toBe(true);
    expect(details.created).toBe(false);
    expect(details.updated).toBe(true);
    expect(details.revision).toBe(2);

    const content = await fs.readFile(path.join(workspaceDir, details.path), "utf8");
    expect(content).toContain(
      "Retrieve the old thesis, carryover cue, and correction trail before giving a fresh stance.",
    );
    expect(content).toContain(
      "Use when the operator asks if the old thesis still holds or when a fresh answer risks ignoring the prior position logic.",
    );
    expect(content).toContain(
      "Narrow first on the old thesis, the live carryover cue, and any correction note before adding fresh market color.",
    );
    expect(content).toContain("### Revision 1");
    expect(content).toContain("Summary:\nRetrieve the old thesis first.");
    expect(content).toContain(
      "revision 2 · updated · tightened the rule after more finance revalidation hardening",
    );
    expect(content).toContain("revision 1 · created · initial capture");
  });

  it("fails closed when an existing local memory card is malformed", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-local-memory-");
    const cardDir = path.join(workspaceDir, "memory", "local-memory");
    await fs.mkdir(cardDir, { recursive: true });
    await fs.writeFile(
      path.join(cardDir, "holding-holdings-thesis-revalidation.md"),
      "# malformed\n\nthis is not a valid local memory card\n",
      "utf8",
    );
    const tool = createLocalMemoryRecordTool({ workspaceDir });

    const result = await tool.execute("memory-malformed", {
      subject: "Holdings thesis revalidation",
      memoryType: "holding",
      summary: "new summary",
    });

    expect(result.details).toEqual({
      ok: false,
      created: false,
      updated: false,
      path: "memory/local-memory/holding-holdings-thesis-revalidation.md",
      reason: "existing_card_malformed",
      action:
        "Repair or archive the malformed local memory card before retrying local_memory_record.",
    });
  });

  it("can revise the universal finance doctrine card without breaking the durable-card format", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-local-memory-");
    const relPath = path.join(
      "memory",
      "local-memory",
      "workflow-universal-finance-decision-under-uncertainty.md",
    );
    const seedContent = await fs.readFile(
      path.join(
        process.cwd(),
        "memory",
        "local-memory",
        "workflow-universal-finance-decision-under-uncertainty.md",
      ),
      "utf8",
    );
    await fs.mkdir(path.dirname(path.join(workspaceDir, relPath)), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, relPath), seedContent, "utf8");

    const tool = createLocalMemoryRecordTool({ workspaceDir });
    const result = await tool.execute("memory-universal-finance-doctrine", {
      subject: "Universal finance decision under uncertainty",
      memoryType: "workflow",
      summary:
        "For most non-HFT finance asks, do not optimize for point prediction; force a bounded scenario frame before action or no-action.",
      updateReason:
        "tightened the universal finance doctrine summary without changing the core schema",
    });
    const details = result.details as {
      ok: boolean;
      created: boolean;
      updated: boolean;
      path: string;
      revision: number;
    };

    expect(details.ok).toBe(true);
    expect(details.created).toBe(false);
    expect(details.updated).toBe(true);
    expect(details.path).toBe(relPath);
    expect(details.revision).toBe(2);

    const content = await fs.readFile(path.join(workspaceDir, relPath), "utf8");
    expect(content).toContain(
      "For most non-HFT finance asks, do not optimize for point prediction; force a bounded scenario frame before action or no-action.",
    );
    expect(content).toContain("## Use This Card When");
    expect(content).toContain(
      "Use when the ask is a finance or economics judgment call and Lobster might otherwise drift into deterministic prediction, narrative-only commentary, or one-case storytelling.",
    );
    expect(content).toContain("## First Narrowing Step");
    expect(content).toContain("## Stop Rule");
    expect(content).toContain("### Revision 1");
    expect(content).toContain(
      "seeded the first universal finance decision-under-uncertainty workflow card",
    );
    expect(content).toContain(
      "revision 2 · updated · tightened the universal finance doctrine summary without changing the core schema",
    );
  });
});
