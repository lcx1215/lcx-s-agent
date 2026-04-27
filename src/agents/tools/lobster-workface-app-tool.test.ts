import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderLobsterWorkfaceArtifact } from "../../hooks/bundled/lobster-brain-registry.js";
import { makeTempWorkspace, writeWorkspaceFile } from "../../test-helpers/workspace.js";

const callGatewayToolMock = vi.hoisted(() => vi.fn());
const resolveNodeIdMock = vi.hoisted(() => vi.fn());

vi.mock("./gateway.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gateway.js")>();
  return {
    ...actual,
    callGatewayTool: (...args: unknown[]) => callGatewayToolMock(...args),
  };
});

vi.mock("./nodes-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./nodes-utils.js")>();
  return {
    ...actual,
    resolveNodeId: (...args: unknown[]) => resolveNodeIdMock(...args),
  };
});

const { createLobsterWorkfaceAppTool } = await import("./lobster-workface-app-tool.js");

function buildWorkfaceContent() {
  return renderLobsterWorkfaceArtifact({
    targetDateKey: "2026-04-09",
    sessionKey: "agent:lobster:main",
    learningItems: 3,
    correctionNotes: 2,
    watchtowerSignals: 1,
    codexEscalations: 1,
    activeSurfaceLanes: 3,
    portfolioScorecard: "7.9/10",
    totalTokens: "4321",
    estimatedCost: "$0.4200",
    dashboardSnapshotLines: ["- Learning Flow: ███ 3 items", "- Corrections: ██ 2 items"],
    validationRadarLines: [
      "- Strongest Domain: fundamental_research",
      "- Weakest Domain: technical_daily",
      "- Hallucination Watch: macro narrative drift",
    ],
    feishuLanePanelLines: [
      "- Active Lanes: 3",
      "- control_room · session main · healthy",
      "- technical_daily · session td-1 · learning carryover fresh",
    ],
    sevenDayOperatingViewLines: ["- Weekly posture: more selective, less noisy."],
    yesterdayLearnedLines: [
      "- keep: retain the higher-bar ETF invalidation checklist",
      "- discard: stop carrying forward stale risk anchors",
      "- replay: rerun this cue when holdings thesis revalidation asks arrive",
      "- next eval: compare tomorrow's holdings brief against this carryover",
    ],
    yesterdayCorrectedLines: ["- corrected: stopped flattening workflow truth into process truth."],
    yesterdayWatchtowerLines: ["- watchtower: watch silent drift in validation quality."],
    codexEscalationLines: ["- escalation: capture final reply before ledger persist."],
    portfolioAnswerScorecardLines: ["- Average Score: 7.9/10", "- Improve Target: timing clarity"],
    tokenDashboardLeadLine: "- Daily token usage stayed within budget.",
    tokenDashboardModelLines: ["- minimax: 2200", "- openai/gpt-5.4: 2121"],
    tokenTrendLines: ["- 2026-04-08: 4010", "- 2026-04-09: 4321"],
    readingGuideLines: ["- Read carryover first, then validation radar, then lane panel."],
  });
}

describe("lobster_workface_app tool", () => {
  let workspaceDir: string | undefined;
  let previousHome: string | undefined;

  afterEach(async () => {
    callGatewayToolMock.mockReset();
    resolveNodeIdMock.mockReset();
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  });

  it("reuses current-research-line when no lobster-workface artifact exists yet", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-workface-app-");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await writeWorkspaceFile({
      dir: path.join(workspaceDir, "memory"),
      name: "current-research-line.md",
      content: [
        "# Current Research Line",
        "",
        "current_focus: holdings_thesis_revalidation",
        "top_decision: re-check whether the old thesis still survives",
        "current_session_summary: current session is narrowing the old thesis instead of forcing a fresh stance",
        "next_step: retrieve the prior thesis and newest invalidation evidence before writing a stance",
        "guardrail: research-only memory; no execution-first behavior",
        "memory_state_contract: verified supports current decisions; provisional requires fresh re-check; stale is drill-down only until re-verified",
        "",
      ].join("\n"),
    });
    const tool = createLobsterWorkfaceAppTool({ workspaceDir });

    const result = await tool.execute("app-missing", {});
    const details = result.details as {
      ok: boolean;
      built: boolean;
      emptyState: boolean;
      sourceArtifact?: string;
      indexPath: string;
      action: string;
    };

    expect(details.ok).toBe(true);
    expect(details.built).toBe(true);
    expect(details.emptyState).toBe(true);
    expect(details.sourceArtifact).toBe("memory/current-research-line.md");
    expect(details.action).toContain("honest empty-state dashboard");
    const html = await fs.readFile(details.indexPath, "utf8");
    expect(html).toContain(
      "No <code>memory/YYYY-MM-DD-lobster-workface.md</code> artifact is available",
    );
    expect(html).toContain("memory/current-research-line.md was parsed successfully");
    expect(html).toContain("holdings_thesis_revalidation");
    expect(html).toContain("re-check whether the old thesis still survives");
    expect(html).toContain("retrieve the prior thesis and newest invalidation evidence");
    expect(html).toContain("research-only memory; no execution-first behavior");
  });

  it("stays honest when current-research-line is present but malformed", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-workface-app-");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await writeWorkspaceFile({
      dir: path.join(workspaceDir, "memory"),
      name: "current-research-line.md",
      content: "# Current Research Line\n",
    });
    const tool = createLobsterWorkfaceAppTool({ workspaceDir });

    const result = await tool.execute("app-missing-malformed-anchor", {});
    const details = result.details as {
      ok: boolean;
      built: boolean;
      emptyState: boolean;
      sourceArtifact?: string;
      indexPath: string;
    };

    expect(details.ok).toBe(true);
    expect(details.built).toBe(true);
    expect(details.emptyState).toBe(true);
    expect(details.sourceArtifact).toBeUndefined();
    const html = await fs.readFile(details.indexPath, "utf8");
    expect(html).toContain("exists but could not be parsed cleanly");
    expect(html).toContain("present but malformed");
  });

  it("builds a bounded local dashboard app from the latest workface artifact", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-workface-app-");
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: "2026-04-09-lobster-workface.md",
      content: buildWorkfaceContent(),
    });
    const tool = createLobsterWorkfaceAppTool({ workspaceDir });

    const result = await tool.execute("app-build", {
      title: "Daily Lobster",
    });
    const details = result.details as {
      ok: boolean;
      built: boolean;
      presented: boolean;
      outputDir: string;
      indexPath: string;
      sourceArtifact: string;
      carryoverComplete: boolean;
    };

    expect(details.ok).toBe(true);
    expect(details.built).toBe(true);
    expect(details.presented).toBe(false);
    expect(details.sourceArtifact).toBe("memory/2026-04-09-lobster-workface.md");
    expect(details.carryoverComplete).toBe(true);
    expect(details.outputDir).toContain(".openclaw/lobster-workface-dashboard");

    const html = await fs.readFile(details.indexPath, "utf8");
    expect(html).toContain("<h1>Daily Lobster</h1>");
    expect(html).toContain("Generated from memory/2026-04-09-lobster-workface.md.");
    expect(html).toContain("retain the higher-bar ETF invalidation checklist");
    expect(html).toContain("macro narrative drift");
    expect(html).toContain("control_room · session main · healthy");
  });

  it("can build to the desktop and present the dashboard in canvas", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-workface-app-");
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: "2026-04-09-lobster-workface.md",
      content: buildWorkfaceContent(),
    });
    previousHome = process.env.HOME;
    const homeDir = path.join(workspaceDir, "home");
    process.env.HOME = homeDir;
    await fs.mkdir(path.join(homeDir, "Desktop"), { recursive: true });
    resolveNodeIdMock.mockResolvedValue("mac-lobster");
    callGatewayToolMock.mockResolvedValue({ ok: true });

    const tool = createLobsterWorkfaceAppTool({ workspaceDir });
    const result = await tool.execute("app-present", {
      destination: "desktop",
      present: true,
      width: 1280,
      height: 900,
    });
    const details = result.details as {
      ok: boolean;
      built: boolean;
      presented: boolean;
      destination: string;
      outputDir: string;
      indexUrl: string;
    };

    expect(details.ok).toBe(true);
    expect(details.built).toBe(true);
    expect(details.presented).toBe(true);
    expect(details.destination).toBe("desktop");
    expect(details.outputDir).toContain("Desktop/Lobster Workface Dashboard");
    expect(details.indexUrl).toMatch(/^file:\/\//u);
    expect(resolveNodeIdMock).toHaveBeenCalled();
    expect(callGatewayToolMock).toHaveBeenCalledWith(
      "node.invoke",
      {
        gatewayUrl: undefined,
        gatewayToken: undefined,
        timeoutMs: undefined,
      },
      expect.objectContaining({
        nodeId: "mac-lobster",
        command: "canvas.present",
        params: expect.objectContaining({
          url: details.indexUrl,
          placement: expect.objectContaining({
            width: 1280,
            height: 900,
          }),
        }),
      }),
    );
  });
});
