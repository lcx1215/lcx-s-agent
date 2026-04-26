import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { writeWorkspaceFile } from "../../../test-helpers/workspace.js";
import { createHookEvent } from "../../hooks.js";
import type { HookHandler } from "../../hooks.js";
import {
  buildLearningCouncilAdoptionLedgerFilename,
  buildLearningCouncilArtifactJsonRelativePath,
  buildWatchtowerArtifactDir,
  isCorrectionNoteFilename,
  parseLearningCouncilAdoptionLedger,
  parseCodexEscalationArtifact,
  parseCorrectionNoteArtifact,
  parseRepairTicketArtifact,
  renderLearningCouncilAdoptionLedger,
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
  suiteWorkspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-correction-loop-"));
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
  tempDir: string;
  sessionContent: string;
  timestamp?: string;
}): Promise<void> {
  const sessionsDir = path.join(params.tempDir, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  const sessionFile = await writeWorkspaceFile({
    dir: sessionsDir,
    name: "correction-session.jsonl",
    content: params.sessionContent,
  });

  const event = createHookEvent("command", "reset", "agent:main:main", {
    cfg: makeConfig(params.tempDir),
    previousSessionEntry: {
      sessionId: "correction-123",
      sessionFile,
    },
  });
  if (params.timestamp) {
    event.timestamp = new Date(params.timestamp);
  }

  await handler(event);
}

describe("correction-loop hook", () => {
  it("writes a structured correction note for feedback-prefixed sessions", async () => {
    const tempDir = await createCaseWorkspace("workspace");
    const sessionContent = createMockSessionContent([
      { role: "assistant", content: "TLT 风险收益比最差，直接减仓。" },
      { role: "user", content: "反馈：你把旧锚点当成了最新数据，而且口气太满。" },
    ]);

    await runResetWithSession({ tempDir, sessionContent });

    const memoryDir = path.join(tempDir, "memory");
    const files = await fs.readdir(memoryDir);
    const correctionFile = files.find((file) => isCorrectionNoteFilename(file));
    expect(correctionFile).toBeTruthy();

    const correctionContent = await fs.readFile(path.join(memoryDir, correctionFile!), "utf-8");
    const parsedCorrection = parseCorrectionNoteArtifact(correctionContent);
    expect(correctionContent).toContain("# Correction Note:");
    expect(correctionContent).toContain("**Memory Tier**: provisional");
    expect(correctionContent).toContain("## Prior Claim Or Behavior");
    expect(correctionContent).toContain("## Foundation Template");
    expect(correctionContent).toContain("## What Was Wrong");
    expect(correctionContent).toContain("## Replacement Rule");
    expect(correctionContent).toContain("你把旧锚点当成了最新数据，而且口气太满。");
    expect(correctionContent).toContain("- outcome-review");
    expect(parsedCorrection).toMatchObject({
      issueKey: expect.any(String),
      memoryTier: "provisional",
      foundationTemplate: "outcome-review",
      whatWasWrong: "你把旧锚点当成了最新数据，而且口气太满。",
      repeatedIssueSignal: "no",
    });
  });

  it("also writes a structured correction note for high-confidence natural complaint corrections", async () => {
    const tempDir = await createCaseWorkspace("workspace");
    const sessionContent = createMockSessionContent([
      { role: "assistant", content: "我直接重写一份完整长文给你。" },
      {
        role: "user",
        content: "你刚才那段还是词不达意。我让你先说动作和范围，不是直接重写长文。",
      },
    ]);

    await runResetWithSession({ tempDir, sessionContent });

    const memoryDir = path.join(tempDir, "memory");
    const files = await fs.readdir(memoryDir);
    const correctionFile = files.find((file) => isCorrectionNoteFilename(file));
    expect(correctionFile).toBeTruthy();

    const correctionContent = await fs.readFile(path.join(memoryDir, correctionFile!), "utf-8");
    const parsedCorrection = parseCorrectionNoteArtifact(correctionContent);
    expect(correctionContent).toContain("词不达意");
    expect(correctionContent).toContain("我让你先说动作和范围，不是直接重写长文。");
    expect(parsedCorrection?.memoryTier).toBe("provisional");
    expect(parsedCorrection?.repeatedIssueSignal).toBe("no");
  });

  it("downranks a reused adoption-ledger row when the exact reused cue is directly corrected", async () => {
    const tempDir = await createCaseWorkspace("workspace");
    const memoryDir = path.join(tempDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    const ledgerFilename = buildLearningCouncilAdoptionLedgerFilename({
      dateStr: "2026-04-11",
      noteSlug: "msg-adoption",
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: ledgerFilename,
      content: renderLearningCouncilAdoptionLedger({
        stem: "msg-adoption",
        generatedAt: "2026-04-11T09:59:00.000Z",
        status: "full",
        userMessage: "去学一下金融主线里最值得内化的东西",
        sourceArtifact: buildLearningCouncilArtifactJsonRelativePath("msg-adoption"),
        entries: [
          {
            source: "learning-council:msg-adoption",
            cueType: "keep",
            text: "keep finance learning tied to the active research line",
            adoptedState: "adopted_now",
            reusedLater: true,
            downrankedOrFailed: false,
            linkedArtifactOrReceipt: buildLearningCouncilArtifactJsonRelativePath("msg-adoption"),
            notes: "seeded from runPacket.keepLines",
          },
          {
            source: "learning-council:msg-adoption",
            cueType: "next_eval",
            text: "verify the next workface carries one concrete finance behavior change",
            adoptedState: "candidate_for_reuse",
            reusedLater: true,
            downrankedOrFailed: false,
            linkedArtifactOrReceipt: buildLearningCouncilArtifactJsonRelativePath("msg-adoption"),
            notes: "candidate next eval cue",
          },
        ],
      }),
    });

    await runResetWithSession({
      tempDir,
      sessionContent: createMockSessionContent([
        { role: "assistant", content: "keep finance learning tied to the active research line" },
        { role: "user", content: "反馈：这句不对，还是太泛了，不能直接当成当前规则。" },
      ]),
      timestamp: "2026-04-11T10:00:00.000Z",
    });

    const parsedLedger = parseLearningCouncilAdoptionLedger({
      filename: ledgerFilename,
      content: await fs.readFile(path.join(memoryDir, ledgerFilename), "utf-8"),
    });
    expect(parsedLedger?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cueType: "keep",
          text: "keep finance learning tied to the active research line",
          reusedLater: true,
          downrankedOrFailed: true,
        }),
        expect.objectContaining({
          cueType: "next_eval",
          text: "verify the next workface carries one concrete finance behavior change",
          reusedLater: true,
          downrankedOrFailed: false,
        }),
      ]),
    );
  });

  it("classifies sizing-related corrections into the portfolio sizing discipline template", async () => {
    const tempDir = await createCaseWorkspace("workspace");
    const sessionContent = createMockSessionContent([
      { role: "assistant", content: "低置信也可以继续重仓加仓。" },
      { role: "user", content: "纠正：你在低置信时还是建议重仓加仓，仓位纪律不对。" },
    ]);

    await runResetWithSession({ tempDir, sessionContent });

    const memoryDir = path.join(tempDir, "memory");
    const files = await fs.readdir(memoryDir);
    const correctionFile = files.find((file) => isCorrectionNoteFilename(file));
    expect(correctionFile).toBeTruthy();

    const correctionContent = await fs.readFile(path.join(memoryDir, correctionFile!), "utf-8");
    expect(correctionContent).toContain("## Foundation Template");
    expect(correctionContent).toContain("- portfolio-sizing-discipline");
  });

  it("classifies behavior-drift corrections into the behavior error template", async () => {
    const tempDir = await createCaseWorkspace("workspace");
    const sessionContent = createMockSessionContent([
      { role: "assistant", content: "这次先追进去，别等了。" },
      { role: "user", content: "反馈：这更像 FOMO 和确认偏误，不像纪律化判断。" },
    ]);

    await runResetWithSession({ tempDir, sessionContent });

    const memoryDir = path.join(tempDir, "memory");
    const files = await fs.readdir(memoryDir);
    const correctionFile = files.find((file) => isCorrectionNoteFilename(file));
    expect(correctionFile).toBeTruthy();

    const correctionContent = await fs.readFile(path.join(memoryDir, correctionFile!), "utf-8");
    expect(correctionContent).toContain("## Foundation Template");
    expect(correctionContent).toContain("- behavior-error-correction");
  });

  it("escalates repeated correction issues into a repair ticket", async () => {
    const tempDir = await createCaseWorkspace("workspace");
    const repeatedIssue = "你还是在 freshness 弱时给出高具体度数字。";

    await runResetWithSession({
      tempDir,
      sessionContent: createMockSessionContent([
        { role: "assistant", content: "当前标普 6500，上涨 1.2%。" },
        { role: "user", content: `反馈：${repeatedIssue}` },
      ]),
      timestamp: "2026-04-11T10:00:00.000Z",
    });

    await runResetWithSession({
      tempDir,
      sessionContent: createMockSessionContent([
        { role: "assistant", content: "当前纳指 21000，风险偏好回暖。" },
        { role: "user", content: `纠正：重复出现，${repeatedIssue}` },
      ]),
      timestamp: "2026-04-11T10:00:01.000Z",
    });

    const ticketsDir = path.join(tempDir, buildWatchtowerArtifactDir("repairTickets"));
    const ticketFiles = await fs.readdir(ticketsDir);
    expect(ticketFiles.length).toBe(1);

    const ticketContent = await fs.readFile(path.join(ticketsDir, ticketFiles[0]), "utf-8");
    const parsedTicket = parseRepairTicketArtifact(ticketContent);
    expect(parsedTicket).toBeTruthy();
    expect(ticketContent).toContain("# Repair Ticket Candidate:");
    expect(ticketContent).toContain("**Occurrences**: 2");
    expect(ticketContent).toContain("provider_or_freshness");
    expect(ticketContent).toContain("**Foundation Template**: outcome-review");
    expect(ticketContent).toContain(repeatedIssue);
    expect(parsedTicket?.category).toBe("provider_or_freshness");
    expect(parsedTicket?.issueKey).toBeTruthy();
    expect(parsedTicket?.foundationTemplate).toBe("outcome-review");
    expect(parsedTicket?.occurrences).toBe(2);
    expect(parsedTicket?.problem).toContain("freshness");

    const anomalyFiles = await fs.readdir(
      path.join(tempDir, buildWatchtowerArtifactDir("anomalies")),
    );
    expect(anomalyFiles.length).toBe(1);
    const anomaly = JSON.parse(
      await fs.readFile(
        path.join(tempDir, buildWatchtowerArtifactDir("anomalies"), anomalyFiles[0]),
        "utf-8",
      ),
    ) as {
      category: string;
      occurrenceCount: number;
      source: string;
      foundationTemplate: string;
    };
    expect(anomaly.category).toBe("provider_or_freshness");
    expect(anomaly.occurrenceCount).toBe(1);
    expect(anomaly.source).toBe("correction-loop");
    expect(anomaly.foundationTemplate).toBe("outcome-review");

    await expect(
      fs.access(path.join(tempDir, buildWatchtowerArtifactDir("codexEscalations"))),
    ).rejects.toThrow();
  });

  it("writes a codex escalation packet for repeated write/edit failures", async () => {
    const tempDir = await createCaseWorkspace("workspace");
    const repeatedIssue = "你还是无法保存文件，修改后没有真正落盘。";

    await runResetWithSession({
      tempDir,
      sessionContent: createMockSessionContent([
        { role: "assistant", content: "我已经改好了并保存。" },
        { role: "user", content: `反馈：${repeatedIssue}` },
      ]),
      timestamp: "2026-04-11T11:00:00.000Z",
    });

    await runResetWithSession({
      tempDir,
      sessionContent: createMockSessionContent([
        { role: "assistant", content: "我已经再次保存成功。" },
        { role: "user", content: `纠正：重复出现，${repeatedIssue}` },
      ]),
      timestamp: "2026-04-11T11:00:01.000Z",
    });

    const codexDir = path.join(tempDir, buildWatchtowerArtifactDir("codexEscalations"));
    const packetFiles = await fs.readdir(codexDir);
    expect(packetFiles.length).toBe(1);

    const packetContent = await fs.readFile(path.join(codexDir, packetFiles[0]), "utf-8");
    const parsedPacket = parseCodexEscalationArtifact(packetContent);
    expect(parsedPacket).toBeTruthy();
    expect(parsedPacket?.category).toBe("write_edit_failure");
    expect(parsedPacket?.source).toBe("correction-loop");
    expect(parsedPacket?.occurrences).toBe(2);
    expect(parsedPacket?.repairTicketPath).toContain("repair-tickets");
    expect(parsedPacket?.problem).toContain("保存文件");
    expect(parsedPacket?.lastSeenDateKey).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(parsedPacket?.generatedDateKey).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(parsedPacket?.lastSeenDateKey).toBe(parsedPacket?.generatedDateKey);
  });

  it("does nothing for ordinary sessions without correction prefixes", async () => {
    const tempDir = await createCaseWorkspace("workspace");
    const sessionContent = createMockSessionContent([
      { role: "user", content: "今天该关注什么，给我一个总览。" },
      { role: "assistant", content: "先看主要指数、利率和风险偏好。" },
    ]);

    await runResetWithSession({ tempDir, sessionContent });

    const memoryDir = path.join(tempDir, "memory");
    const memoryFiles = await fs.readdir(memoryDir).catch(() => []);
    expect(memoryFiles.some((file) => isCorrectionNoteFilename(file))).toBe(false);
    await expect(
      fs.access(path.join(tempDir, buildWatchtowerArtifactDir("repairTickets"))),
    ).rejects.toThrow();
  });
});
