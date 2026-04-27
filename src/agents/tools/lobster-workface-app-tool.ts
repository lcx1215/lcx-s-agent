import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "@sinclair/typebox";
import {
  buildLobsterWorkfaceFilename,
  isLobsterWorkfaceFilename,
  parseCurrentResearchLineArtifact,
  parseLobsterWorkfaceArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { ToolInputError, jsonResult, readNumberParam, readStringParam } from "./common.js";
import { callGatewayTool, readGatewayCallOptions } from "./gateway.js";
import { resolveNodeId } from "./nodes-utils.js";

const LOBSTER_WORKFACE_APP_DESTINATIONS = ["workspace", "desktop"] as const;
const LOBSTER_PROTECTED_ANCHORS = [
  "memory/current-research-line.md",
  "memory/unified-risk-view.md",
  "MEMORY.md",
] as const;

const LobsterWorkfaceAppSchema = Type.Object({
  dateKey: Type.Optional(Type.String()),
  destination: optionalStringEnum(LOBSTER_WORKFACE_APP_DESTINATIONS),
  outputDir: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  present: Type.Optional(Type.Boolean()),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
  node: Type.Optional(Type.String()),
  x: Type.Optional(Type.Number()),
  y: Type.Optional(Type.Number()),
  width: Type.Optional(Type.Number()),
  height: Type.Optional(Type.Number()),
});

type WorkfaceSection = {
  title: string;
  lines: string[];
};

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeDisplayLine(line: string): string {
  return line.replace(/^- /u, "").trim();
}

function expandHomeDir(rawPath: string): string {
  if (rawPath.startsWith("~/") && process.env.HOME) {
    return path.join(process.env.HOME, rawPath.slice(2));
  }
  return rawPath;
}

function isPathInside(parentDir: string, childPath: string): boolean {
  const relative = path.relative(parentDir, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveDesktopDir(): string | undefined {
  const homeDir = process.env.HOME?.trim();
  if (!homeDir) {
    return undefined;
  }
  return path.join(homeDir, "Desktop");
}

function extractSectionLines(content: string, heading: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n");
  const headingMarker = `## ${heading}\n`;
  const startIndex = normalized.indexOf(headingMarker);
  if (startIndex < 0) {
    return [];
  }
  const sectionStart = startIndex + headingMarker.length;
  const remaining = normalized.slice(sectionStart);
  const nextHeadingIndex = remaining.indexOf("\n## ");
  const block = nextHeadingIndex >= 0 ? remaining.slice(0, nextHeadingIndex) : remaining;
  return block
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

function renderMetricCard(label: string, value: string, tone: "accent" | "muted" = "accent") {
  return `
    <article class="metric-card ${tone}">
      <span class="metric-label">${escapeHtml(label)}</span>
      <strong class="metric-value">${escapeHtml(value)}</strong>
    </article>
  `;
}

function renderListSection(section: WorkfaceSection): string {
  const items =
    section.lines.length > 0
      ? section.lines
          .map((line) => `<li class="panel-line">${escapeHtml(normalizeDisplayLine(line))}</li>`)
          .join("")
      : '<li class="panel-line muted">No entries recorded.</li>';
  return `
    <section class="panel">
      <h2>${escapeHtml(section.title)}</h2>
      <ul class="panel-list">${items}</ul>
    </section>
  `;
}

function buildCarryoverRows(parsed: ReturnType<typeof parseLobsterWorkfaceArtifact>): string {
  const carryover = [
    { label: "Retain", value: parsed?.learningKeep },
    { label: "Discard", value: parsed?.learningDiscard },
    { label: "Replay", value: parsed?.learningReplay },
    { label: "Next Eval", value: parsed?.learningNextEval },
  ];
  return carryover
    .map(
      (entry) => `
        <article class="carryover-card">
          <span class="carryover-label">${escapeHtml(entry.label)}</span>
          <strong class="carryover-value">${escapeHtml(entry.value?.trim() || "Not recorded yet")}</strong>
        </article>
      `,
    )
    .join("");
}

function buildWorkfaceSections(content: string): WorkfaceSection[] {
  return [
    { title: "Dashboard Snapshot", lines: extractSectionLines(content, "Dashboard Snapshot") },
    { title: "Validation Radar", lines: extractSectionLines(content, "Validation Radar") },
    { title: "Feishu Lane Panel", lines: extractSectionLines(content, "Feishu Lane Panel") },
    { title: "Yesterday Learned", lines: extractSectionLines(content, "Yesterday Learned") },
    { title: "Yesterday Corrected", lines: extractSectionLines(content, "Yesterday Corrected") },
    { title: "Yesterday Watchtower", lines: extractSectionLines(content, "Yesterday Watchtower") },
    { title: "Codex Escalations", lines: extractSectionLines(content, "Codex Escalations") },
    { title: "Token Dashboard", lines: extractSectionLines(content, "Token Dashboard") },
    { title: "Reading Guide", lines: extractSectionLines(content, "Reading Guide") },
  ];
}

function buildWorkfaceDashboardHtml(params: {
  title: string;
  fileLabel: string;
  generatedAt: string;
  content: string;
}) {
  const parsed = parseLobsterWorkfaceArtifact(params.content);
  const strongestDomain = parsed?.strongestDomain?.trim() || "Not recorded";
  const weakestDomain = parsed?.weakestDomain?.trim() || "Not recorded";
  const hallucinationWatch = parsed?.hallucinationWatch?.trim() || "Not recorded";
  const sections = buildWorkfaceSections(params.content);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(params.title)}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f5f1e8;
        --panel: rgba(255, 252, 246, 0.96);
        --panel-border: rgba(76, 61, 46, 0.12);
        --ink: #221a14;
        --muted: #6c5d51;
        --accent: #165d52;
        --accent-soft: rgba(22, 93, 82, 0.12);
        --warn: #8f4d19;
        --warn-soft: rgba(143, 77, 25, 0.12);
        --shadow: 0 22px 48px rgba(48, 32, 18, 0.12);
        --radius: 24px;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        font-family: "Avenir Next", "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top left, rgba(22, 93, 82, 0.12), transparent 34%),
          radial-gradient(circle at top right, rgba(143, 77, 25, 0.14), transparent 32%),
          linear-gradient(180deg, #f8f4ea 0%, var(--bg) 100%);
        color: var(--ink);
      }

      .frame {
        max-width: 1280px;
        margin: 0 auto;
        padding: 28px;
      }

      .hero {
        background: linear-gradient(135deg, rgba(255, 252, 246, 0.98), rgba(244, 236, 222, 0.96));
        border: 1px solid var(--panel-border);
        border-radius: 32px;
        box-shadow: var(--shadow);
        padding: 30px;
        display: grid;
        gap: 12px;
      }

      .eyebrow {
        text-transform: uppercase;
        letter-spacing: 0.18em;
        font-size: 12px;
        color: var(--muted);
      }

      h1 {
        margin: 0;
        font-size: clamp(34px, 5vw, 56px);
        line-height: 1;
      }

      .hero-copy {
        margin: 0;
        color: var(--muted);
        font-size: 15px;
      }

      .hero-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 4px;
      }

      .chip {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 10px 14px;
        border-radius: 999px;
        font-size: 13px;
        background: rgba(255, 255, 255, 0.72);
        border: 1px solid var(--panel-border);
      }

      .metric-grid,
      .info-grid,
      .section-grid {
        display: grid;
        gap: 16px;
        margin-top: 20px;
      }

      .metric-grid {
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      }

      .info-grid,
      .section-grid {
        grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      }

      .metric-card,
      .panel,
      .carryover-card {
        background: var(--panel);
        border: 1px solid var(--panel-border);
        border-radius: var(--radius);
        box-shadow: var(--shadow);
      }

      .metric-card {
        padding: 18px;
        display: grid;
        gap: 8px;
      }

      .metric-card.accent {
        background: linear-gradient(180deg, rgba(22, 93, 82, 0.12), rgba(255, 252, 246, 0.96));
      }

      .metric-card.muted {
        background: linear-gradient(180deg, rgba(143, 77, 25, 0.12), rgba(255, 252, 246, 0.96));
      }

      .metric-label,
      .carryover-label {
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        color: var(--muted);
      }

      .metric-value {
        font-size: clamp(26px, 4vw, 38px);
        line-height: 1;
      }

      .panel {
        padding: 22px;
      }

      .panel h2 {
        margin: 0 0 14px;
        font-size: 18px;
      }

      .carryover-grid {
        display: grid;
        gap: 12px;
      }

      .carryover-card {
        padding: 16px;
        background: linear-gradient(180deg, var(--accent-soft), rgba(255, 252, 246, 0.96));
      }

      .carryover-value {
        display: block;
        margin-top: 8px;
        font-size: 15px;
        line-height: 1.45;
      }

      .panel-list {
        list-style: none;
        padding: 0;
        margin: 0;
        display: grid;
        gap: 10px;
      }

      .panel-line {
        padding: 12px 14px;
        border-radius: 16px;
        background: rgba(17, 24, 39, 0.04);
        line-height: 1.45;
        font-size: 14px;
      }

      .panel-line.muted {
        color: var(--muted);
        background: rgba(17, 24, 39, 0.03);
      }

      .validation-grid {
        display: grid;
        gap: 12px;
      }

      .validation-row {
        padding: 14px 16px;
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.8);
        border: 1px solid var(--panel-border);
      }

      .validation-row strong {
        display: block;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        color: var(--muted);
        margin-bottom: 6px;
      }

      .footer {
        margin-top: 20px;
        color: var(--muted);
        font-size: 13px;
        text-align: right;
      }
    </style>
  </head>
  <body>
    <main class="frame">
      <section class="hero">
        <div class="eyebrow">Lobster Daily Workface App</div>
        <h1>${escapeHtml(params.title)}</h1>
        <p class="hero-copy">
          Generated from ${escapeHtml(params.fileLabel)}. This is a bounded local dashboard over the latest Lobster workface artifact, not a free-form app builder.
        </p>
        <div class="hero-meta">
          <span class="chip">Date ${escapeHtml(parsed?.dateKey ?? "unknown")}</span>
          <span class="chip">Portfolio ${escapeHtml(parsed?.portfolioScorecard?.trim() || "not scored")}</span>
          <span class="chip">Active lanes ${escapeHtml(parsed?.activeSurfaceLanes?.trim() || "0")}</span>
          <span class="chip">Generated ${escapeHtml(params.generatedAt)}</span>
        </div>
      </section>

      <section class="metric-grid">
        ${renderMetricCard("Learning Items", parsed?.learningItems ?? "0")}
        ${renderMetricCard("Corrections", parsed?.correctionNotes ?? "0")}
        ${renderMetricCard("Watchtower", parsed?.watchtowerSignals ?? "0")}
        ${renderMetricCard("Codex Escalations", parsed?.codexEscalations ?? "0", "muted")}
        ${renderMetricCard("Tokens", parsed?.totalTokens ?? "0")}
        ${renderMetricCard("Estimated Cost", parsed?.estimatedCost ?? "$0.0000", "muted")}
      </section>

      <section class="info-grid">
        <section class="panel">
          <h2>Carryover Cue</h2>
          <div class="carryover-grid">
            ${buildCarryoverRows(parsed)}
          </div>
        </section>
        <section class="panel">
          <h2>Validation Posture</h2>
          <div class="validation-grid">
            <article class="validation-row">
              <strong>Strongest Domain</strong>
              <span>${escapeHtml(strongestDomain)}</span>
            </article>
            <article class="validation-row">
              <strong>Weakest Domain</strong>
              <span>${escapeHtml(weakestDomain)}</span>
            </article>
            <article class="validation-row">
              <strong>Hallucination Watch</strong>
              <span>${escapeHtml(hallucinationWatch)}</span>
            </article>
          </div>
        </section>
      </section>

      <section class="section-grid">
        ${sections.map((section) => renderListSection(section)).join("")}
      </section>

      <div class="footer">Refresh this dashboard by rerunning lobster_workface_app against a newer workface artifact.</div>
    </main>
  </body>
</html>`;
}

function buildEmptyStateDashboardHtml(params: {
  title: string;
  generatedAt: string;
  statusLine: string;
  anchorStates: Array<{ path: string; present: boolean }>;
  currentResearchLine?: ReturnType<typeof parseCurrentResearchLineArtifact>;
  currentResearchLineStatus?: "used" | "malformed" | "missing";
}) {
  const present = params.anchorStates.filter((entry) => entry.present).map((entry) => entry.path);
  const missing = params.anchorStates.filter((entry) => !entry.present).map((entry) => entry.path);
  const currentResearchLine = params.currentResearchLine;
  const currentResearchLineStatus =
    params.currentResearchLineStatus ?? (currentResearchLine ? "used" : "missing");
  const presentList =
    present.length > 0
      ? present.map((entry) => `<li class="panel-line">${escapeHtml(entry)}</li>`).join("")
      : '<li class="panel-line muted">No protected anchors present yet.</li>';
  const missingList =
    missing.length > 0
      ? missing.map((entry) => `<li class="panel-line">${escapeHtml(entry)}</li>`).join("")
      : '<li class="panel-line muted">No protected anchors missing.</li>';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(params.title)}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f6f0e6;
        --ink: #231a15;
        --muted: #6c5e53;
        --panel: rgba(255, 252, 247, 0.96);
        --panel-border: rgba(74, 58, 44, 0.12);
        --accent: #8f4d19;
        --accent-soft: rgba(143, 77, 25, 0.12);
        --shadow: 0 22px 44px rgba(48, 32, 18, 0.12);
        --radius: 24px;
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Avenir Next", "Segoe UI", sans-serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(143, 77, 25, 0.14), transparent 34%),
          linear-gradient(180deg, #faf5ec 0%, var(--bg) 100%);
      }

      .frame {
        max-width: 1180px;
        margin: 0 auto;
        padding: 28px;
      }

      .hero, .panel {
        background: var(--panel);
        border: 1px solid var(--panel-border);
        border-radius: 30px;
        box-shadow: var(--shadow);
      }

      .hero {
        padding: 30px;
        display: grid;
        gap: 14px;
      }

      .eyebrow {
        text-transform: uppercase;
        letter-spacing: 0.18em;
        font-size: 12px;
        color: var(--muted);
      }

      h1 {
        margin: 0;
        font-size: clamp(34px, 5vw, 54px);
        line-height: 1;
      }

      .hero-copy {
        margin: 0;
        color: var(--muted);
        font-size: 15px;
        line-height: 1.5;
      }

      .status-pill {
        display: inline-flex;
        width: fit-content;
        align-items: center;
        padding: 10px 14px;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--accent);
        border: 1px solid rgba(143, 77, 25, 0.16);
        font-weight: 600;
      }

      .grid {
        display: grid;
        gap: 18px;
        margin-top: 20px;
        grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      }

      .panel {
        padding: 22px;
      }

      .panel h2 {
        margin: 0 0 14px;
        font-size: 18px;
      }

      .panel-list {
        list-style: none;
        padding: 0;
        margin: 0;
        display: grid;
        gap: 10px;
      }

      .panel-line {
        padding: 12px 14px;
        border-radius: 16px;
        background: rgba(17, 24, 39, 0.04);
        font-size: 14px;
        line-height: 1.45;
      }

      .panel-line.muted {
        color: var(--muted);
        background: rgba(17, 24, 39, 0.03);
      }

      .footer {
        margin-top: 18px;
        text-align: right;
        color: var(--muted);
        font-size: 13px;
      }
    </style>
  </head>
  <body>
    <main class="frame">
      <section class="hero">
        <div class="eyebrow">Lobster Daily Workface App</div>
        <h1>${escapeHtml(params.title)}</h1>
        <div class="status-pill">${escapeHtml(params.statusLine)}</div>
        <p class="hero-copy">
          No <code>memory/YYYY-MM-DD-lobster-workface.md</code> artifact is available in this workspace yet, so this dashboard is rendering an honest empty state instead of inventing a fake daily summary.
        </p>
        <p class="hero-copy">
          ${
            currentResearchLineStatus === "used"
              ? "Fallback anchor: memory/current-research-line.md was parsed successfully, so this shell is using the current research focus and next step instead of collapsing to a blank placeholder."
              : currentResearchLineStatus === "malformed"
                ? "Fallback anchor: memory/current-research-line.md exists but could not be parsed cleanly, so this shell is staying honest instead of inventing a current focus."
                : "Next step: generate the daily workface artifact, then rerun <code>lobster_workface_app</code> to replace this shell with the real daily visualization."
          }
        </p>
      </section>

      <section class="grid">
        <section class="panel">
          <h2>Current Research Line</h2>
          <ul class="panel-list">
            ${
              currentResearchLine
                ? [
                    `<li class="panel-line"><strong>Current Focus</strong><br />${escapeHtml(currentResearchLine.currentFocus)}</li>`,
                    `<li class="panel-line"><strong>Top Decision</strong><br />${escapeHtml(currentResearchLine.topDecision)}</li>`,
                    `<li class="panel-line"><strong>Current Session</strong><br />${escapeHtml(currentResearchLine.currentSessionSummary ?? currentResearchLine.currentSession?.intake ?? "none")}</li>`,
                    `<li class="panel-line"><strong>Next Step</strong><br />${escapeHtml(currentResearchLine.nextStep)}</li>`,
                    `<li class="panel-line"><strong>Research Guardrail</strong><br />${escapeHtml(currentResearchLine.researchGuardrail)}</li>`,
                  ].join("")
                : currentResearchLineStatus === "malformed"
                  ? '<li class="panel-line muted">memory/current-research-line.md is present but malformed. Repair that anchor before treating it as current-state truth.</li>'
                  : '<li class="panel-line muted">No reusable current research line is available yet.</li>'
            }
          </ul>
        </section>
        <section class="panel">
          <h2>Expected Artifact</h2>
          <ul class="panel-list">
            <li class="panel-line">memory/YYYY-MM-DD-lobster-workface.md</li>
            <li class="panel-line">Contains learned / corrected / watchtower / carryover / token state</li>
            <li class="panel-line">This app will auto-rebuild from the newest matching artifact</li>
          </ul>
        </section>
        <section class="panel">
          <h2>Protected Anchors Present</h2>
          <ul class="panel-list">${presentList}</ul>
        </section>
        <section class="panel">
          <h2>Protected Anchors Missing</h2>
          <ul class="panel-list">${missingList}</ul>
        </section>
      </section>

      <div class="footer">Generated ${escapeHtml(params.generatedAt)}</div>
    </main>
  </body>
</html>`;
}

async function resolveOutputDir(params: {
  workspaceDir: string;
  outputDir?: string;
  destination?: string;
}): Promise<{ outputDir: string; destination: "workspace" | "desktop" }> {
  const requested = params.outputDir?.trim();
  const desktopDir = resolveDesktopDir();
  if (requested) {
    const expanded = path.resolve(expandHomeDir(requested));
    if (isPathInside(params.workspaceDir, expanded)) {
      return { outputDir: expanded, destination: "workspace" };
    }
    if (desktopDir && isPathInside(desktopDir, expanded)) {
      return { outputDir: expanded, destination: "desktop" };
    }
    throw new ToolInputError(
      "outputDir must stay inside the workspace or inside ~/Desktop for lobster_workface_app",
    );
  }

  if (params.destination === "desktop") {
    if (!desktopDir) {
      throw new ToolInputError("desktop destination unavailable because HOME/Desktop is missing");
    }
    return {
      outputDir: path.join(desktopDir, "Lobster Workface Dashboard"),
      destination: "desktop",
    };
  }

  return {
    outputDir: path.join(params.workspaceDir, ".openclaw", "lobster-workface-dashboard"),
    destination: "workspace",
  };
}

async function resolveWorkfaceArtifact(params: {
  workspaceDir: string;
  dateKey?: string;
}): Promise<
  | { state: "ready"; filename: string; content: string }
  | { state: "missing"; message: string }
  | { state: "unavailable"; error: unknown }
> {
  try {
    const memoryDir = path.join(params.workspaceDir, "memory");
    const filename = params.dateKey?.trim()
      ? buildLobsterWorkfaceFilename(params.dateKey.trim())
      : (await fs.readdir(memoryDir, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && isLobsterWorkfaceFilename(entry.name))
          .map((entry) => entry.name)
          .toSorted()
          .at(-1);
    if (!filename) {
      return { state: "missing", message: "No lobster-workface artifact found yet." };
    }
    const content = await fs.readFile(path.join(memoryDir, filename), "utf8");
    return { state: "ready", filename, content };
  } catch (error) {
    return { state: "unavailable", error };
  }
}

async function resolveProtectedAnchorStates(workspaceDir: string) {
  return await Promise.all(
    LOBSTER_PROTECTED_ANCHORS.map(async (relPath) => {
      try {
        await fs.access(path.join(workspaceDir, relPath));
        return { path: relPath, present: true };
      } catch {
        return { path: relPath, present: false };
      }
    }),
  );
}

async function resolveCurrentResearchLineFallback(workspaceDir: string): Promise<{
  status: "used" | "malformed" | "missing";
  path: string;
  parsed?: ReturnType<typeof parseCurrentResearchLineArtifact>;
}> {
  const relPath = "memory/current-research-line.md";
  const absPath = path.join(workspaceDir, relPath);
  try {
    const content = await fs.readFile(absPath, "utf8");
    const parsed = parseCurrentResearchLineArtifact(content);
    if (!parsed) {
      return { status: "malformed", path: relPath };
    }
    return { status: "used", path: relPath, parsed };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing", path: relPath };
    }
    throw error;
  }
}

export function createLobsterWorkfaceAppTool(options?: { workspaceDir?: string }): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Lobster Workface App",
    name: "lobster_workface_app",
    description:
      "Build a bounded local Lobster daily-work dashboard app from the latest lobster-workface artifact, either in the workspace or on the Desktop. Optionally present it in Canvas. This is for Lobster's own daily work visualization, not a general app builder.",
    parameters: LobsterWorkfaceAppSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const dateKey = readStringParam(params, "dateKey");
      const title = readStringParam(params, "title") ?? "Lobster Daily Workface";
      const present = params.present === true;
      const outputDirInput = readStringParam(params, "outputDir");
      const destinationInput = readStringParam(params, "destination");
      const { outputDir, destination } = await resolveOutputDir({
        workspaceDir,
        outputDir: outputDirInput,
        destination: destinationInput,
      });
      await fs.mkdir(outputDir, { recursive: true });
      const generatedAt = new Date().toISOString();
      const indexPath = path.join(outputDir, "index.html");

      const artifact = await resolveWorkfaceArtifact({ workspaceDir, dateKey });
      if (artifact.state === "unavailable") {
        return jsonResult({
          ok: false,
          built: false,
          presented: false,
          reason: "workface_unavailable",
          error: artifact.error instanceof Error ? artifact.error.message : String(artifact.error),
          action: "Repair workspace memory access, then retry lobster_workface_app.",
        });
      }

      let html: string;
      let sourceArtifact: string | undefined;
      let emptyStateAction =
        "Built an honest empty-state dashboard because no lobster-workface artifact exists yet.";
      let dateKeyResolved: string | undefined;
      let carryoverComplete = false;
      let metrics:
        | {
            learningItems: string;
            correctionNotes: string;
            watchtowerSignals: string;
            codexEscalations: string;
            totalTokens: string;
            estimatedCost: string;
          }
        | undefined;
      let emptyState = false;

      if (artifact.state === "missing") {
        emptyState = true;
        const anchorStates = await resolveProtectedAnchorStates(workspaceDir);
        const currentResearchLine = await resolveCurrentResearchLineFallback(workspaceDir);
        html = buildEmptyStateDashboardHtml({
          title,
          generatedAt,
          statusLine: artifact.message,
          anchorStates,
          currentResearchLine: currentResearchLine.parsed,
          currentResearchLineStatus: currentResearchLine.status,
        });
        if (currentResearchLine.status === "used") {
          sourceArtifact = currentResearchLine.path;
          emptyStateAction =
            "Built an honest empty-state dashboard and reused memory/current-research-line.md as the bounded fallback anchor because no lobster-workface artifact exists yet.";
        } else if (currentResearchLine.status === "malformed") {
          emptyStateAction =
            "Built an honest empty-state dashboard because the lobster workface artifact is missing and memory/current-research-line.md is present but malformed.";
        }
      } else {
        const parsed = parseLobsterWorkfaceArtifact(artifact.content);
        if (!parsed) {
          return jsonResult({
            ok: false,
            built: false,
            presented: false,
            reason: "workface_parse_failed",
            artifact: artifact.filename,
            action:
              "Repair the malformed lobster-workface artifact before retrying lobster_workface_app.",
          });
        }
        html = buildWorkfaceDashboardHtml({
          title,
          fileLabel: `memory/${artifact.filename}`,
          generatedAt,
          content: artifact.content,
        });
        sourceArtifact = `memory/${artifact.filename}`;
        dateKeyResolved = parsed.dateKey;
        carryoverComplete =
          Boolean(parsed.learningKeep) &&
          Boolean(parsed.learningDiscard) &&
          Boolean(parsed.learningReplay) &&
          Boolean(parsed.learningNextEval);
        metrics = {
          learningItems: parsed.learningItems,
          correctionNotes: parsed.correctionNotes,
          watchtowerSignals: parsed.watchtowerSignals,
          codexEscalations: parsed.codexEscalations,
          totalTokens: parsed.totalTokens,
          estimatedCost: parsed.estimatedCost,
        };
      }
      await fs.writeFile(indexPath, html, "utf8");

      let presented = false;
      let presentError: string | undefined;
      if (present) {
        try {
          const gatewayOpts = readGatewayCallOptions(params);
          const nodeId = await resolveNodeId(
            gatewayOpts,
            readStringParam(params, "node", { trim: true }),
            true,
          );
          const placement = {
            x: readNumberParam(params, "x"),
            y: readNumberParam(params, "y"),
            width: readNumberParam(params, "width"),
            height: readNumberParam(params, "height"),
          };
          const invokeParams: Record<string, unknown> = {
            url: pathToFileURL(indexPath).toString(),
          };
          if (Object.values(placement).some((value) => value !== undefined)) {
            invokeParams.placement = placement;
          }
          await callGatewayTool("node.invoke", gatewayOpts, {
            nodeId,
            command: "canvas.present",
            params: invokeParams,
            idempotencyKey: crypto.randomUUID(),
          });
          presented = true;
        } catch (error) {
          presentError = error instanceof Error ? error.message : String(error);
        }
      }

      return jsonResult({
        ok: !presentError,
        built: true,
        presented,
        destination,
        outputDir,
        indexPath,
        indexUrl: pathToFileURL(indexPath).toString(),
        title,
        emptyState,
        sourceArtifact,
        dateKey: dateKeyResolved,
        carryoverComplete,
        metrics,
        action: presentError
          ? "The dashboard file was built, but Canvas presentation failed. Open the generated index.html manually or retry with present=true after fixing gateway/node availability."
          : emptyState
            ? emptyStateAction
            : "Dashboard app updated successfully.",
        error: presentError,
      });
    },
  };
}
