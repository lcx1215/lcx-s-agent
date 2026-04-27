import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillStatusEntry } from "../../../src/agents/skills-status.js";
import { createEmptyRequirements } from "../../../src/cli/requirements-test-fixtures.js";
import {
  parseMarketIntelligenceRuntimeArtifact,
  renderMarketIntelligenceRuntimeArtifact,
} from "../../../src/hooks/bundled/lobster-brain-registry.js";
import { runFeishuMarketIntelligencePacket } from "./market-intelligence.js";

const {
  mockCallGateway,
  mockInstallSkill,
  mockBuildWorkspaceSkillStatus,
  mockRunCommandWithTimeout,
  mockRecordOperationalAnomaly,
} = vi.hoisted(() => ({
  mockCallGateway: vi.fn(),
  mockInstallSkill: vi.fn(),
  mockBuildWorkspaceSkillStatus: vi.fn(),
  mockRunCommandWithTimeout: vi.fn(),
  mockRecordOperationalAnomaly: vi.fn(),
}));

vi.mock("../../../src/gateway/call.js", () => ({
  callGateway: mockCallGateway,
  randomIdempotencyKey: vi.fn(() => "idem-market"),
}));

vi.mock("../../../src/agents/skills-install.js", () => ({
  installSkill: mockInstallSkill,
}));

vi.mock("../../../src/agents/skills-status.js", () => ({
  buildWorkspaceSkillStatus: mockBuildWorkspaceSkillStatus,
}));

vi.mock("../../../src/process/exec.js", () => ({
  runCommandWithTimeout: mockRunCommandWithTimeout,
}));

vi.mock("../../../src/infra/operational-anomalies.js", () => ({
  recordOperationalAnomaly: mockRecordOperationalAnomaly,
}));

const TEST_CFG = {} as ClawdbotConfig;

function summarizeSkillStatus(params?: Partial<SkillStatusEntry>): SkillStatusEntry {
  return {
    name: "summarize",
    description: "Summarize URLs and files",
    source: "openclaw-bundled",
    bundled: true,
    filePath: "/tmp/skills/summarize/SKILL.md",
    baseDir: "/tmp/skills/summarize",
    skillKey: "summarize",
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    eligible: true,
    requirements: createEmptyRequirements(),
    missing: createEmptyRequirements(),
    configChecks: [],
    install: [],
    ...params,
  };
}

async function seedCurrentResearchLine(workspaceDir: string): Promise<void> {
  await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceDir, "memory", "current-research-line.md"),
    [
      "# Current Research Line",
      "",
      "current_focus: Re-risk QQQ only if rates and dollar stop squeezing growth.",
      "line_status: active",
      "top_decision: Whether to stay patient on the current ETF transmission line.",
      "current_session_summary: Keep the current ETF macro line active until a real transmission break appears.",
      "next_step: Re-check rates, dollar, and breadth before changing the working stance.",
      "research_guardrail: research-only; no execution approval and no fake certainty.",
      "",
    ].join("\n"),
    "utf-8",
  );
}

async function readLatestMarketArtifact(workspaceDir: string): Promise<{
  relativePath: string;
  content: string;
}> {
  const dir = path.join(workspaceDir, "bank", "knowledge", "market-intelligence");
  const files = (await fs.readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  const latest = files.at(-1);
  if (!latest) {
    throw new Error("missing market-intelligence artifact");
  }
  const relativePath = `bank/knowledge/market-intelligence/${latest}`;
  return {
    relativePath,
    content: await fs.readFile(path.join(dir, latest), "utf-8"),
  };
}

describe("runFeishuMarketIntelligencePacket", () => {
  beforeEach(() => {
    mockCallGateway.mockReset();
    mockInstallSkill.mockReset();
    mockBuildWorkspaceSkillStatus.mockReset();
    mockRunCommandWithTimeout.mockReset();
    mockRecordOperationalAnomaly.mockReset();
  });

  it("runs the full bounded role chain, auto-installs summarize, and uses its digest inside the packet", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-market-intelligence-"));
    await seedCurrentResearchLine(workspaceDir);
    mockBuildWorkspaceSkillStatus
      .mockReturnValueOnce({
        workspaceDir,
        managedSkillsDir: "/tmp/skills",
        skills: [
          summarizeSkillStatus({
            eligible: false,
            install: [
              { id: "brew", kind: "brew", label: "Install summarize", bins: ["summarize"] },
            ],
          }),
        ],
      })
      .mockReturnValueOnce({
        workspaceDir,
        managedSkillsDir: "/tmp/skills",
        skills: [
          summarizeSkillStatus({
            eligible: false,
            install: [
              { id: "brew", kind: "brew", label: "Install summarize", bins: ["summarize"] },
            ],
          }),
        ],
      })
      .mockReturnValueOnce({
        workspaceDir,
        managedSkillsDir: "/tmp/skills",
        skills: [summarizeSkillStatus()],
      });
    mockInstallSkill.mockResolvedValue({
      ok: true,
      message: "Installed",
      stdout: "",
      stderr: "",
      code: 0,
    });
    mockRunCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout:
        '{"summary":"Dollar pause and rates drift are the freshest input into the ETF transmission line."}',
      stderr: "",
      signal: null,
      killed: false,
      termination: "exit",
    });
    mockCallGateway
      .mockResolvedValueOnce({
        result: {
          payloads: [
            {
              text: JSON.stringify({
                hypothesis_set: [
                  {
                    id: "h1",
                    label: "Growth rebound alive",
                    stance: "bullish",
                    thesis:
                      "If rates and dollar stop tightening together, QQQ can re-risk faster than the rest of the tape.",
                    key_drivers: ["rates drift lower", "dollar pause", "duration bid returns"],
                  },
                  {
                    id: "h2",
                    label: "Duration still fragile",
                    stance: "bearish",
                    thesis:
                      "If rates stay sticky and the dollar firms again, long-duration growth is still the weak link.",
                    key_drivers: ["sticky real yields", "dollar squeeze", "breadth still narrow"],
                  },
                ],
                evidence_gaps: ["Need fresher breadth confirmation."],
                material_change_flag: "material",
                material_change_reasons: [
                  "Source digest says dollar pause is new enough to reopen the bracket.",
                ],
                follow_up_candidates: ["Check breadth and credit at the same time."],
                confidence_band: "medium",
              }),
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            {
              text: JSON.stringify({
                hypothesis_set: [
                  {
                    id: "h1",
                    label: "Growth rebound alive",
                    stance: "bullish",
                    thesis:
                      "The live transmission line improves only if rates and dollar stop compounding duration pressure together.",
                    key_drivers: ["rates pause", "dollar pause", "growth beta relief"],
                  },
                  {
                    id: "h2",
                    label: "Duration still fragile",
                    stance: "bearish",
                    thesis:
                      "Without cleaner breadth and credit confirmation, any bounce is still vulnerable to another rates shock.",
                    key_drivers: ["breadth weak", "credit not confirming", "yields still elevated"],
                  },
                ],
                evidence_gaps: ["Credit confirmation is still weak."],
                follow_up_candidates: ["Check HY spreads before leaning into QQQ."],
                confidence_band: "medium",
              }),
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            {
              text: JSON.stringify({
                challenge_findings: [
                  {
                    thesis_id: "h2",
                    finding:
                      "The bearish case is overstating fragility without a fresh dollar squeeze.",
                    severity: "medium",
                    evidence_needed:
                      "Need renewed dollar strength and broader risk-off confirmation.",
                  },
                ],
                surviving_thesis_ids: ["h1"],
                rejected_thesis_ids: ["h2"],
              }),
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            {
              text: JSON.stringify({
                survivor_theses: [
                  {
                    thesis_id: "h1",
                    label: "Growth rebound alive",
                    why_survived:
                      "Rates and dollar pressure look less one-sided than the previous packet, so the bullish bracket survives the evidence gate.",
                  },
                ],
                follow_up_candidates: ["Verify breadth and credit before promoting the bracket."],
                confidence_band: "medium",
              }),
            },
          ],
        },
      });

    const reply = await runFeishuMarketIntelligencePacket({
      cfg: TEST_CFG,
      userMessage:
        "今天做一个 ETF / macro intelligence packet，参考 https://example.com/market-note ，给我 SPY QQQ rates dollar 的情报包",
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:dm:ou-user",
      messageId: "msg-market-1",
      workspaceDir,
    });

    expect(mockInstallSkill).toHaveBeenCalledTimes(1);
    expect(mockRunCommandWithTimeout).toHaveBeenCalledWith(
      [
        "summarize",
        "https://example.com/market-note",
        "--length",
        "short",
        "--max-output-tokens",
        "600",
        "--json",
      ],
      expect.objectContaining({ cwd: workspaceDir, timeoutMs: 90_000 }),
    );
    expect(mockCallGateway).toHaveBeenCalledTimes(4);
    expect(String(mockCallGateway.mock.calls[0]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "source_digest_1:",
    );
    expect(String(mockCallGateway.mock.calls[0]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "Dollar pause and rates drift are the freshest input",
    );
    expect(reply).toContain("## Market Intelligence Packet");
    expect(reply).toContain("### Competing theses");
    expect(reply).toContain("### Survivor theses");
    expect(reply).toContain("### Skill receipt");

    const latest = await readLatestMarketArtifact(workspaceDir);
    const parsed = parseMarketIntelligenceRuntimeArtifact(latest.content);
    expect(parsed?.materialChangeFlag).toBe("material");
    expect(parsed?.skillReceipt.status).toBe("installed_and_used");
    expect(parsed?.sourceDigests[0]).toContain("https://example.com/market-note");
    expect(parsed?.challengeFindings[0]?.thesisId).toBe("h2");
    expect(parsed?.survivorTheses[0]?.thesisId).toBe("h1");
    expect(parsed?.retainedResidueLines[0]).toContain("Growth rebound alive");
    expect(mockRecordOperationalAnomaly).not.toHaveBeenCalled();
  });

  it("suppresses low-value reruns with the same fingerprint and reuses the existing approved skill", async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-market-intelligence-repeat-"),
    );
    await seedCurrentResearchLine(workspaceDir);
    mockBuildWorkspaceSkillStatus.mockReturnValue({
      workspaceDir,
      managedSkillsDir: "/tmp/skills",
      skills: [summarizeSkillStatus()],
    });
    mockRunCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout:
        '{"summary":"Dollar pause and rates drift are the freshest input into the ETF transmission line."}',
      stderr: "",
      signal: null,
      killed: false,
      termination: "exit",
    });
    mockCallGateway
      .mockResolvedValueOnce({
        result: {
          payloads: [
            {
              text: JSON.stringify({
                hypothesis_set: [
                  {
                    id: "h1",
                    label: "Growth rebound alive",
                    stance: "bullish",
                    thesis:
                      "If rates and dollar stop tightening together, QQQ can re-risk faster than the rest of the tape.",
                    key_drivers: ["rates drift lower", "dollar pause"],
                  },
                  {
                    id: "h2",
                    label: "Duration still fragile",
                    stance: "bearish",
                    thesis:
                      "If rates stay sticky and the dollar firms again, long-duration growth is still the weak link.",
                    key_drivers: ["sticky real yields", "dollar squeeze"],
                  },
                ],
                evidence_gaps: ["Need fresher breadth confirmation."],
                material_change_flag: "material",
                material_change_reasons: ["The bracket remains contested."],
                follow_up_candidates: ["Check breadth and credit at the same time."],
                confidence_band: "medium",
              }),
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            {
              text: JSON.stringify({
                hypothesis_set: [
                  {
                    id: "h1",
                    label: "Growth rebound alive",
                    stance: "bullish",
                    thesis:
                      "The live transmission line improves only if rates and dollar stop compounding duration pressure together.",
                    key_drivers: ["rates pause", "dollar pause"],
                  },
                  {
                    id: "h2",
                    label: "Duration still fragile",
                    stance: "bearish",
                    thesis:
                      "Without cleaner breadth and credit confirmation, any bounce is still vulnerable.",
                    key_drivers: ["breadth weak", "credit not confirming"],
                  },
                ],
                evidence_gaps: ["Credit confirmation is still weak."],
                follow_up_candidates: ["Check HY spreads before leaning into QQQ."],
                confidence_band: "medium",
              }),
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            {
              text: JSON.stringify({
                challenge_findings: [
                  {
                    thesis_id: "h2",
                    finding:
                      "The bearish case is overstating fragility without a fresh dollar squeeze.",
                    severity: "medium",
                    evidence_needed:
                      "Need renewed dollar strength and broader risk-off confirmation.",
                  },
                ],
                surviving_thesis_ids: ["h1"],
                rejected_thesis_ids: ["h2"],
              }),
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            {
              text: JSON.stringify({
                survivor_theses: [
                  {
                    thesis_id: "h1",
                    label: "Growth rebound alive",
                    why_survived:
                      "Rates and dollar pressure look less one-sided than the previous packet, so the bullish bracket survives the evidence gate.",
                  },
                ],
                follow_up_candidates: ["Verify breadth and credit before promoting the bracket."],
                confidence_band: "medium",
              }),
            },
          ],
        },
      });

    await runFeishuMarketIntelligencePacket({
      cfg: TEST_CFG,
      userMessage:
        "今天做一个 ETF / macro intelligence packet，参考 https://example.com/market-note ，给我 SPY QQQ rates dollar 的情报包",
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:dm:ou-user",
      messageId: "msg-market-repeat-1",
      workspaceDir,
    });

    mockCallGateway.mockReset();
    mockInstallSkill.mockReset();
    mockCallGateway.mockResolvedValueOnce({
      result: {
        payloads: [
          {
            text: JSON.stringify({
              hypothesis_set: [
                {
                  id: "h1",
                  label: "Growth rebound alive",
                  stance: "bullish",
                  thesis:
                    "If rates and dollar stop tightening together, QQQ can re-risk faster than the rest of the tape.",
                  key_drivers: ["rates drift lower", "dollar pause"],
                },
                {
                  id: "h2",
                  label: "Duration still fragile",
                  stance: "bearish",
                  thesis:
                    "If rates stay sticky and the dollar firms again, long-duration growth is still the weak link.",
                  key_drivers: ["sticky real yields", "dollar squeeze"],
                },
              ],
              evidence_gaps: ["Need fresher breadth confirmation."],
              material_change_flag: "material",
              material_change_reasons: ["The bracket remains contested."],
              follow_up_candidates: ["Check breadth and credit at the same time."],
              confidence_band: "medium",
            }),
          },
        ],
      },
    });

    const reply = await runFeishuMarketIntelligencePacket({
      cfg: TEST_CFG,
      userMessage:
        "今天做一个 ETF / macro intelligence packet，参考 https://example.com/market-note ，给我 SPY QQQ rates dollar 的情报包",
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:dm:ou-user",
      messageId: "msg-market-repeat-2",
      workspaceDir,
    });

    expect(mockCallGateway).toHaveBeenCalledTimes(1);
    expect(mockInstallSkill).not.toHaveBeenCalled();
    expect(reply).toContain("- material change: no_material_change");
    const latest = await readLatestMarketArtifact(workspaceDir);
    const parsed = parseMarketIntelligenceRuntimeArtifact(latest.content);
    expect(parsed?.noMaterialChange).toBe(true);
    expect(parsed?.skillReceipt.status).toBe("activated_existing");
    expect(parsed?.comparedAgainstArtifactPath).toContain("bank/knowledge/market-intelligence/");
  });

  it("fails closed when the scout lane does not return a valid structured object", async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-market-intelligence-fail-closed-"),
    );
    await seedCurrentResearchLine(workspaceDir);
    mockBuildWorkspaceSkillStatus.mockReturnValue({
      workspaceDir,
      managedSkillsDir: "/tmp/skills",
      skills: [summarizeSkillStatus()],
    });
    mockRunCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: '{"summary":"digest"}',
      stderr: "",
      signal: null,
      killed: false,
      termination: "exit",
    });
    mockCallGateway.mockResolvedValueOnce({
      result: {
        payloads: [{ text: "not valid json" }],
      },
    });

    const reply = await runFeishuMarketIntelligencePacket({
      cfg: TEST_CFG,
      userMessage:
        "今天做一个 ETF / macro intelligence packet，参考 https://example.com/market-note ，给我 SPY QQQ rates dollar 的情报包",
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:dm:ou-user",
      messageId: "msg-market-fail-closed",
      workspaceDir,
    });

    expect(reply).toContain("- status: failed_closed");
    expect(reply).toContain("- scout failure:");
    const artifactDir = path.join(workspaceDir, "bank", "knowledge", "market-intelligence");
    await expect(fs.readdir(artifactDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("renders and parses the structured market-intelligence artifact contract", () => {
    const rendered = renderMarketIntelligenceRuntimeArtifact({
      version: 1,
      generatedAt: "2026-04-13T12:00:00.000Z",
      messageId: "msg-structured",
      userMessage: "today packet",
      topicKey: "same-day-etf-index-macro-packet",
      fingerprint: "abc123def4567890",
      materialChangeFlag: "material",
      materialChangeReasons: ["rates and dollar bracket shifted"],
      noMaterialChange: false,
      confidenceBand: "medium",
      anchor: {
        lineStatus: "active",
        currentFocus: "focus",
        topDecision: "decision",
        nextStep: "next",
        researchGuardrail: "research-only",
      },
      sourceContext: {
        sourceRefs: ["https://example.com"],
        sourceDigests: ["https://example.com: digest"],
        skillReceipt: {
          skillName: "summarize",
          status: "activated_existing",
          reason: "already available",
        },
      },
      routing: {
        scout: { model: "qianfan/deepseek-v3.2", ran: true },
        synthesizer: { model: "moonshot/kimi-k2.5", ran: true },
        challenger: { model: "minimax/MiniMax-M2.7", ran: true },
        arbiter: { model: "openai/gpt-5.2", ran: true },
        distiller: { mode: "deterministic" },
      },
      hypothesisSet: [
        {
          id: "h1",
          label: "Growth rebound alive",
          stance: "bullish",
          thesis: "thesis",
          keyDrivers: ["driver"],
        },
        {
          id: "h2",
          label: "Duration still fragile",
          stance: "bearish",
          thesis: "other thesis",
          keyDrivers: ["driver"],
        },
      ],
      evidenceGaps: ["gap"],
      challengeFindings: [
        {
          thesisId: "h2",
          finding: "weakness",
          severity: "medium",
          evidenceNeeded: "check breadth",
        },
      ],
      survivorTheses: [
        {
          thesisId: "h1",
          label: "Growth rebound alive",
          whySurvived: "survived the gate",
        },
      ],
      followUpCandidates: ["follow-up"],
      distillation: {
        retainedResidueLines: ["residue"],
        downrankedLines: ["downranked"],
        operatorSummaryLines: ["summary"],
        memoryNotePath: "memory/2026-04-13-market-intelligence-note.md",
      },
      finalReply: "reply",
    });

    const parsed = parseMarketIntelligenceRuntimeArtifact(rendered);
    expect(parsed?.messageId).toBe("msg-structured");
    expect(parsed?.topicKey).toBe("same-day-etf-index-macro-packet");
    expect(parsed?.skillReceipt.status).toBe("activated_existing");
    expect(parsed?.survivorTheses[0]?.thesisId).toBe("h1");
    expect(parsed?.retainedResidueLines).toEqual(["residue"]);
  });
});
