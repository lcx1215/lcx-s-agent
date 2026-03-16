import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { writeWorkspaceFile } from "../../../test-helpers/workspace.js";
import type { HookHandler } from "../../hooks.js";
import { createHookEvent } from "../../hooks.js";

let handler: HookHandler;
let suiteWorkspaceRoot = "";
let workspaceCaseCounter = 0;

async function createCaseWorkspace(prefix = "workspace"): Promise<string> {
  const dir = path.join(suiteWorkspaceRoot, `${prefix}-${workspaceCaseCounter}`);
  workspaceCaseCounter += 1;
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

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

async function runResetWithSession(params: { sessionContent: string }): Promise<{
  memoryFiles: string[];
  noteContent: string;
  intakeContent: string;
  manifestContent: string;
}> {
  const tempDir = await createCaseWorkspace();
  const sessionsDir = path.join(tempDir, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  const sessionFile = await writeWorkspaceFile({
    dir: sessionsDir,
    name: "fundamental-session.jsonl",
    content: params.sessionContent,
  });

  const event = createHookEvent("command", "reset", "agent:main:main", {
    cfg: makeConfig(tempDir),
    previousSessionEntry: {
      sessionId: "fundamental-123",
      sessionFile,
    },
  });
  event.timestamp = new Date("2026-03-15T12:00:00.000Z");

  await handler(event);

  const memoryDir = path.join(tempDir, "memory");
  const bankIntakesDir = path.join(tempDir, "bank", "fundamental", "intakes");
  const bankManifestsDir = path.join(tempDir, "bank", "fundamental", "manifests");
  const memoryFiles = await fs.readdir(memoryDir);
  const intakeFiles = await fs.readdir(bankIntakesDir);
  const manifestFiles = await fs.readdir(bankManifestsDir);
  const noteContent = await fs.readFile(path.join(memoryDir, memoryFiles[0]), "utf-8");
  const intakeContent = await fs.readFile(path.join(bankIntakesDir, intakeFiles[0]), "utf-8");
  const manifestContent = await fs.readFile(path.join(bankManifestsDir, manifestFiles[0]), "utf-8");

  return {
    memoryFiles,
    noteContent,
    intakeContent,
    manifestContent,
  };
}

beforeAll(async () => {
  ({ default: handler } = await import("./handler.js"));
  suiteWorkspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fundamental-intake-"));
});

afterAll(async () => {
  if (!suiteWorkspaceRoot) {
    return;
  }
  await fs.rm(suiteWorkspaceRoot, { recursive: true, force: true });
  suiteWorkspaceRoot = "";
  workspaceCaseCounter = 0;
});

describe("fundamental-intake hook", () => {
  it("turns a giants request into an intake spec and manifest scaffold", async () => {
    const sessionContent = createMockSessionContent([
      {
        role: "user",
        content:
          "Go read important giants' financial reports and research reports in China, the US, and Europe. Keep this as a fundamental watchlist intake.",
      },
      {
        role: "assistant",
        content:
          "I will keep it controlled and turn the request into a manifest-first scaffold instead of fetching anything.",
      },
    ]);

    const { memoryFiles, noteContent, intakeContent, manifestContent } = await runResetWithSession({
      sessionContent,
    });
    const intake = JSON.parse(intakeContent) as Record<string, unknown>;
    const manifest = JSON.parse(manifestContent) as Record<string, unknown>;

    expect(memoryFiles[0]).toContain("fundamental-intake");
    expect(noteContent).toContain("# Fundamental Intake:");
    expect(noteContent).toContain("regions: china, us, europe");
    expect(noteContent).toContain("target_universe: important giants");
    expect(noteContent).toContain(
      "document_types: annual_report, quarterly_report, research_report",
    );
    expect(noteContent).toContain("scaffold_status: scaffold_only");
    expect(noteContent).toContain("required_documents_expected: 4");
    expect(noteContent).toContain(
      "file_name_pattern: <target-slug>--<document-category>--<source-type>--<YYYYMMDD>.<ext>",
    );

    expect(String(intake.requestTitle)).toContain("Go read important giants'");
    expect(intake.regions).toEqual(["china", "us", "europe"]);
    expect(intake.targetEntities).toEqual([]);
    expect(intake.targetUniverse).toEqual(["important giants", "watchlist candidates"]);
    expect(intake.assetType).toBe("equity");
    expect(intake.issuerType).toBe("public_company");
    expect(intake.priority).toBe("high");
    expect(intake.documentTypes).toEqual(["annual_report", "quarterly_report", "research_report"]);

    expect(manifest.researchBranch).toBe("fundamental_research_branch");
    expect(manifest.manifestId).toBe("important-giants");
    expect(manifest.scaffoldStatus).toBe("scaffold_only");
    expect(manifest.collectionStatus).toEqual({
      documentsPresent: false,
      evidenceReady: false,
      requiredDocumentsExpected: 4,
      requiredDocumentsPresent: 0,
      optionalDocumentsPresent: 0,
      notes: [
        "Manifest scaffold only. No local documents are assumed to exist yet.",
        "Document collection must stay manifest-first and approval-gated.",
      ],
    });
    expect(manifest.riskHandoff).toEqual({
      status: "not_ready_for_risk_handoff",
      riskAuditPath: null,
      notes: [
        "No evidence, snapshot, score, or penalty artifacts exist yet.",
        "Risk handoff remains blocked until approved documents are collected and reviewed.",
      ],
    });
    expect(manifest.documentWorkspace).toEqual({
      baseDir: "bank/fundamental/documents/important-giants",
      targetDirs: [
        {
          targetLabel: "TBD_CHINA_IMPORTANT_GIANTS",
          dir: "bank/fundamental/documents/important-giants/tbd-china-important-giants",
        },
        {
          targetLabel: "TBD_US_WATCHLIST_CANDIDATES",
          dir: "bank/fundamental/documents/important-giants/tbd-us-watchlist-candidates",
        },
      ],
    });
    expect(manifest.documentConventions).toEqual({
      fileNamePattern: "<target-slug>--<document-category>--<source-type>--<YYYYMMDD>.<ext>",
      metadataSidecarSuffix: ".meta.json",
      allowedExtensions: ["pdf", "html", "md", "txt", "docx", "xlsx"],
    });
  });

  it("creates placeholders for a watchlist request without pretending entities already exist", async () => {
    const sessionContent = createMockSessionContent([
      {
        role: "user",
        content:
          "Build a watchlist research scaffold for large-cap semis in the US and AI infrastructure names globally. Use annual reports, quarterly reports, and investor presentations.",
      },
      {
        role: "assistant",
        content:
          "I will keep this as a controlled intake and generate placeholders instead of inventing already-collected documents.",
      },
    ]);

    const { noteContent, intakeContent, manifestContent } = await runResetWithSession({
      sessionContent,
    });
    const intake = JSON.parse(intakeContent) as Record<string, unknown>;
    const manifest = JSON.parse(manifestContent) as {
      targets: Array<Record<string, unknown>>;
      documentPlan: Array<Record<string, unknown>>;
    };

    expect(noteContent).toContain("target_entities: none yet");
    expect(noteContent).toContain(
      "target_universe: large-cap semis, ai infrastructure names, watchlist candidates",
    );

    expect(intake.regions).toEqual(["us", "global"]);
    expect(intake.targetEntities).toEqual([]);
    expect(intake.targetUniverse).toEqual([
      "large-cap semis",
      "ai infrastructure names",
      "watchlist candidates",
    ]);
    expect(intake.documentTypes).toEqual([
      "annual_report",
      "quarterly_report",
      "investor_presentation",
    ]);

    expect(manifest.targets.some((target) => target.label === "large-cap semis")).toBe(true);
    expect(manifest.targets.some((target) => target.label === "ai infrastructure names")).toBe(
      true,
    );
    expect(
      manifest.targets.some(
        (target) =>
          typeof target.label === "string" &&
          target.label.startsWith("TBD_US_LARGE_CAP_SEMIS") &&
          target.resolution === "placeholder",
      ),
    ).toBe(true);
    expect(
      manifest.documentPlan.every(
        (documentPlan) => documentPlan.status === "missing" && documentPlan.required === true,
      ),
    ).toBe(true);
    expect(manifest.documentWorkspace).toEqual({
      baseDir: "bank/fundamental/documents/large-cap-semis",
      targetDirs: [
        {
          targetLabel: "TBD_US_LARGE_CAP_SEMIS",
          dir: "bank/fundamental/documents/large-cap-semis/tbd-us-large-cap-semis",
        },
        {
          targetLabel: "TBD_GLOBAL_AI_INFRASTRUCTURE_NAMES",
          dir: "bank/fundamental/documents/large-cap-semis/tbd-global-ai-infrastructure-names",
        },
        {
          targetLabel: "TBD_US_WATCHLIST_CANDIDATES",
          dir: "bank/fundamental/documents/large-cap-semis/tbd-us-watchlist-candidates",
        },
      ],
    });
  });

  it("does nothing for non-fundamental sessions", async () => {
    const tempDir = await createCaseWorkspace();
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "non-fundamental.jsonl",
      content: createMockSessionContent([
        { role: "user", content: "Help me shorten this product slogan." },
        { role: "assistant", content: "I can make it punchier." },
      ]),
    });

    const event = createHookEvent("command", "reset", "agent:main:main", {
      cfg: makeConfig(tempDir),
      previousSessionEntry: {
        sessionId: "non-fundamental",
        sessionFile,
      },
    });
    event.timestamp = new Date("2026-03-15T12:00:00.000Z");

    await handler(event);

    await expect(fs.readdir(path.join(tempDir, "memory"))).resolves.toEqual([]);
    await expect(fs.access(path.join(tempDir, "bank"))).rejects.toThrow();
  });
});
