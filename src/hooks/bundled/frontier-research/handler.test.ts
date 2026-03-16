import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { writeWorkspaceFile } from "../../../test-helpers/workspace.js";
import { createHookEvent } from "../../hooks.js";
import type { HookHandler } from "../../hooks.js";

vi.mock("../../llm-slug-generator.js", () => ({
  generateSlugViaLLM: vi.fn().mockResolvedValue("wave-card"),
}));

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
  suiteWorkspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-frontier-research-"));
});

afterAll(async () => {
  if (!suiteWorkspaceRoot) {
    return;
  }
  await fs.rm(suiteWorkspaceRoot, { recursive: true, force: true });
  suiteWorkspaceRoot = "";
  workspaceCaseCounter = 0;
});

function createMockSessionContent(entries: Array<{ role: string; content: string }>): string {
  return entries
    .map((entry) =>
      JSON.stringify({
        type: "message",
        message: {
          role: entry.role,
          content: entry.content,
        },
      }),
    )
    .join("\n");
}

function makeConfig(tempDir: string): OpenClawConfig {
  return {
    agents: { defaults: { workspace: tempDir } },
  } satisfies OpenClawConfig;
}

async function runResetWithSession(params: {
  sessionContent: string;
}): Promise<{ files: string[]; cardContent: string }> {
  const tempDir = await createCaseWorkspace("workspace");
  const sessionsDir = path.join(tempDir, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  const sessionFile = await writeWorkspaceFile({
    dir: sessionsDir,
    name: "frontier-session.jsonl",
    content: params.sessionContent,
  });

  const event = createHookEvent("command", "reset", "agent:main:main", {
    cfg: makeConfig(tempDir),
    previousSessionEntry: {
      sessionId: "frontier-123",
      sessionFile,
    },
  });

  await handler(event);

  const memoryDir = path.join(tempDir, "memory");
  const files = await fs.readdir(memoryDir);
  const cardFile = files.find((name) => name.includes("frontier-research")) ?? "";
  const cardContent = cardFile ? await fs.readFile(path.join(memoryDir, cardFile), "utf-8") : "";
  return { files, cardContent };
}

describe("frontier-research hook", () => {
  it("writes a frontier research card for paper-heavy sessions", async () => {
    const sessionContent = createMockSessionContent([
      { role: "user", content: "Please review this WaveLSFormer paper and tell me whether it is worth a toy reproduction." },
      { role: "assistant", content: "It looks like a time-series transformer paper with multi-scale structure extraction and possible leakage risk in windowing." },
      { role: "user", content: "Focus on leakage, overfitting, the data setup, and whether we should reproduce it." },
      { role: "assistant", content: "The paper claims multi-scale preprocessing improves signal quality, but the evaluation should use walk-forward splits and benchmark simpler baselines." },
      { role: "assistant", content: "My tentative verdict is worth reproducing, but only with leakage-safe splits over historical time series." },
    ]);

    const { files, cardContent } = await runResetWithSession({ sessionContent });

    expect(files.some((name) => name.includes("frontier-research"))).toBe(true);
    expect(cardContent).toContain("# Frontier Research Card:");
    expect(cardContent).toContain("material_type: paper");
    expect(cardContent).toContain("method_family: time-series-transformer");
    expect(cardContent).toContain("title: WaveLSFormer");
    expect(cardContent).toContain("claimed_contribution:");
    expect(cardContent).toContain("data_setup:");
    expect(cardContent).toContain("evaluation_protocol:");
    expect(cardContent).toContain("key_results:");
    expect(cardContent).toContain("possible_leakage_points:");
    expect(cardContent).toContain("overfitting_risks:");
    expect(cardContent).toContain("verdict: worth_reproducing");
    expect(cardContent).toContain("WaveLSFormer paper");
  });

  it("does nothing for non-frontier sessions", async () => {
    const sessionContent = createMockSessionContent([
      { role: "user", content: "Help me rename this product and shorten the tagline." },
      { role: "assistant", content: "We can make it punchier and more brandable." },
    ]);

    const { files } = await runResetWithSession({ sessionContent });

    expect(files.some((name) => name.includes("frontier-research"))).toBe(false);
  });

  it("prefers explicitly labeled structured fields when the session already contains them", async () => {
    const sessionContent = createMockSessionContent([
      {
        role: "user",
        content: [
          "Please turn these notes into a research card.",
          "Title: Chronos Risk Whitepaper",
          "Material Type: whitepaper",
          "Method Family: llm-finance-method",
          "Data Setup: earnings-call transcripts aligned with daily price reactions.",
        ].join("\n"),
      },
      {
        role: "assistant",
        content: [
          "Claimed Contribution: a structured LLM extraction pipeline can improve event representation consistency.",
          "Evaluation Protocol: compare against keyword baselines with time-safe retrieval and cost-aware replay evaluation.",
          "Key Results: extraction quality may improve, but market-signal claims remain weak.",
          "Verdict: archive_for_knowledge",
        ].join("\n"),
      },
    ]);

    const { cardContent } = await runResetWithSession({ sessionContent });

    expect(cardContent).toContain("title: Chronos Risk Whitepaper");
    expect(cardContent).toContain("material_type: whitepaper");
    expect(cardContent).toContain("method_family: llm-finance-method");
    expect(cardContent).toContain(
      "data_setup: earnings-call transcripts aligned with daily price reactions.",
    );
    expect(cardContent).toContain(
      "evaluation_protocol: compare against keyword baselines with time-safe retrieval and cost-aware replay evaluation.",
    );
    expect(cardContent).toContain(
      "claimed_contribution: a structured LLM extraction pipeline can improve event representation consistency.",
    );
    expect(cardContent).toContain("key_results: extraction quality may improve, but market-signal claims remain weak.");
    expect(cardContent).toContain("verdict: archive_for_knowledge");
  });
});
