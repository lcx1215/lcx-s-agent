import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { writeWorkspaceFile } from "../../../test-helpers/workspace.js";
import { createHookEvent } from "../../hooks.js";
import type { HookHandler } from "../../hooks.js";
import {
  buildKnowledgeValidationNoteFilename,
  buildKnowledgeValidationWeeklyArtifactFilename,
  parseKnowledgeValidationWeeklyArtifact,
} from "../lobster-brain-registry.js";

let handler: HookHandler;
let suiteWorkspaceRoot = "";
let workspaceCaseCounter = 0;

async function createCaseWorkspace(prefix = "case"): Promise<string> {
  const dir = path.join(suiteWorkspaceRoot, `${prefix}-${workspaceCaseCounter}`);
  workspaceCaseCounter += 1;
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

beforeAll(async () => {
  ({ default: handler } = await import("./handler.js"));
  suiteWorkspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-knowledge-validation-"));
});

afterAll(async () => {
  if (!suiteWorkspaceRoot) {
    return;
  }
  await fs.rm(suiteWorkspaceRoot, { recursive: true, force: true });
  suiteWorkspaceRoot = "";
  workspaceCaseCounter = 0;
});

function makeConfig(tempDir: string): OpenClawConfig {
  return {
    agents: { defaults: { workspace: tempDir } },
  } satisfies OpenClawConfig;
}

async function runReset(tempDir: string, isoTime = "2026-03-27T15:00:00.000Z") {
  const sessionsDir = path.join(tempDir, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  const sessionFile = await writeWorkspaceFile({
    dir: sessionsDir,
    name: "validation-session.jsonl",
    content: "",
  });
  const event = createHookEvent("command", "reset", "agent:main:main", {
    cfg: makeConfig(tempDir),
    previousSessionEntry: {
      sessionId: "validation-123",
      sessionFile,
    },
  });
  event.timestamp = new Date(isoTime);
  await handler(event);
}

describe("knowledge-validation-weekly hook", () => {
  it("writes one weekly validation report from benchmark and daily task notes", async () => {
    const tempDir = await createCaseWorkspace("workspace");
    const memoryDir = path.join(tempDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });

    await writeWorkspaceFile({
      dir: memoryDir,
      name: buildKnowledgeValidationNoteFilename({
        dateStr: "2026-03-25",
        noteSlug: "financebench-qa",
      }),
      content: [
        "# Knowledge Validation Note: financebench-qa",
        "",
        "- validation_type: benchmark",
        "- capability_family: finance",
        "- benchmark_family: financebench_style_qa",
        "- task_family: none",
        "- domain: filing-grounded financial qa",
        "- confidence_mode: high_confidence",
        "- factual_quality: 4",
        "- reasoning_quality: 3",
        "- hallucination_risk: medium",
        "- verdict: mixed",
        "",
        "## Correction Candidate",
        "- tighten source-grounded quote discipline on filing questions",
        "",
        "## Repair Ticket Candidate",
        "- none",
        "",
      ].join("\n"),
    });

    await writeWorkspaceFile({
      dir: memoryDir,
      name: buildKnowledgeValidationNoteFilename({
        dateStr: "2026-03-26",
        noteSlug: "position-questions",
      }),
      content: [
        "# Knowledge Validation Note: position-questions",
        "",
        "- validation_type: daily_real_task",
        "- capability_family: finance",
        "- benchmark_family: none",
        "- task_family: position_management",
        "- domain: position management",
        "- confidence_mode: low_fidelity",
        "- factual_quality: 3",
        "- reasoning_quality: 2",
        "- hallucination_risk: high",
        "- verdict: fail",
        "",
        "## Correction Candidate",
        "- force clearer add / reduce / wait separation under low-fidelity conditions",
        "",
        "## Repair Ticket Candidate",
        "- patch position-answer confidence discipline only",
        "",
      ].join("\n"),
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: buildKnowledgeValidationNoteFilename({
        dateStr: "2026-03-27",
        noteSlug: "repair-triage",
      }),
      content: [
        "# Knowledge Validation Note: repair-triage",
        "",
        "- validation_type: daily_real_task",
        "- capability_family: code_system",
        "- benchmark_family: none",
        "- task_family: code_repair_judgment",
        "- domain: bounded repair planning",
        "- confidence_mode: high_confidence",
        "- factual_quality: 4",
        "- reasoning_quality: 4",
        "- hallucination_risk: low",
        "- verdict: pass",
        "",
        "## Correction Candidate",
        "- none",
        "",
        "## Repair Ticket Candidate",
        "- none",
        "",
      ].join("\n"),
    });

    await runReset(tempDir);

    const content = await fs.readFile(
      path.join(memoryDir, buildKnowledgeValidationWeeklyArtifactFilename("2026-W13")),
      "utf-8",
    );
    const parsed = parseKnowledgeValidationWeeklyArtifact(content);
    expect(content).toContain("# Knowledge Validation Weekly: 2026-W13");
    expect(content).toContain("## Benchmark Coverage");
    expect(content).toContain("financebench_style_qa: 1 note");
    expect(content).toContain("## Daily Real-Task Coverage");
    expect(content).toContain("position_management: 1 note");
    expect(content).toContain("code_repair_judgment: 1 note");
    expect(content).toContain("## Capability-Family Coverage");
    expect(content).toContain("finance: 2 notes");
    expect(content).toContain("code_system: 1 note");
    expect(content).toContain("## Strongest Domains");
    expect(content).toContain("filing-grounded financial qa");
    expect(content).toContain("## Weakest Domains");
    expect(content).toContain("position management");
    expect(content).toContain("## Hallucination-Prone Domains");
    expect(content).toContain("position management: 1 risky validation note");
    expect(content).toContain("## Correction Candidates");
    expect(content).toContain("tighten source-grounded quote discipline on filing questions");
    expect(content).toContain("## Repair-Ticket Candidates");
    expect(content).toContain("patch position-answer confidence discipline only");
    expect(parsed).toMatchObject({
      weekKey: "2026-W13",
      strongestDomain: expect.stringContaining("factual"),
      weakestDomain: expect.stringContaining("position management"),
      hallucinationDomain: expect.stringContaining("risky validation note"),
    });
  });

  it("does nothing when no weekly validation notes exist", async () => {
    const tempDir = await createCaseWorkspace("workspace");
    await runReset(tempDir);

    await expect(
      fs.access(
        path.join(tempDir, "memory", buildKnowledgeValidationWeeklyArtifactFilename("2026-W13")),
      ),
    ).rejects.toThrow();
  });
});
