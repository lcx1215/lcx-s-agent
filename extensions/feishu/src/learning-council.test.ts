import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildLearningCouncilArtifactJsonRelativePath,
  buildLearningCouncilArtifactMarkdownRelativePath,
  buildLearningCouncilAdoptionLedgerFilename,
  buildLearningCouncilMemoryNoteFilename,
  extractIsoDateKey,
  parseLearningCouncilAdoptionLedger,
  parseLearningCouncilMemoryNote,
  parseLearningCouncilRuntimeArtifact,
} from "../../../src/hooks/bundled/lobster-brain-registry.js";
import { runFeishuLearningCouncil } from "./learning-council.js";

const { mockCallGateway, mockRecordOperationalAnomaly } = vi.hoisted(() => ({
  mockCallGateway: vi.fn(),
  mockRecordOperationalAnomaly: vi.fn(),
}));

vi.mock("../../../src/gateway/call.js", () => ({
  callGateway: mockCallGateway,
  randomIdempotencyKey: vi.fn(() => "idem-test"),
}));

vi.mock("../../../src/infra/operational-anomalies.js", () => ({
  recordOperationalAnomaly: mockRecordOperationalAnomaly,
}));

const TEST_CFG = {} as ClawdbotConfig;

describe("runFeishuLearningCouncil", () => {
  beforeEach(() => {
    mockCallGateway.mockReset();
    mockRecordOperationalAnomaly.mockReset();
    delete process.env.OPENCLAW_LEARNING_COUNCIL_KIMI_MODEL;
    delete process.env.OPENCLAW_LEARNING_COUNCIL_MINIMAX_MODEL;
    delete process.env.OPENCLAW_LEARNING_COUNCIL_DEEPSEEK_MODEL;
    delete process.env.OPENCLAW_MINIMAX_DEFAULT_MODEL;
  });

  it("runs Kimi and DeepSeek first, then feeds both into MiniMax audit with extra pressure for finance-mainline topics", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-learning-council-"));
    mockCallGateway
      .mockResolvedValueOnce({
        result: {
          payloads: [
            {
              text: "## Synthesis\n- long-duration growth is sensitive to rates\n## Freshness and caveats\n- mutable facts still need checking",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            {
              text: "## Candidate lessons\n- separate valuation pressure from narrative pressure\n## Candidate follow-ups\n- verify rates and credit jointly\n## Weak evidence\n- current breadth signal is missing",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            {
              text: "## What holds up\n- rates still matter for long-duration risk assets\n## Challenges\n- do not assume every yield rise is inflation-led\n## Evidence gaps\n- credit and dollar confirmation still missing",
            },
          ],
        },
      });

    const result = await runFeishuLearningCouncil({
      cfg: TEST_CFG,
      userMessage: "用三个模型一起学一下美债收益率、QQQ 和风险偏好的关系",
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:dm:ou-user",
      messageId: "msg-learning-1",
      workspaceDir,
    });

    expect(mockCallGateway).toHaveBeenCalledTimes(4);
    expect(mockCallGateway.mock.calls[0]?.[0]).toMatchObject({
      method: "agent",
      params: expect.objectContaining({
        agentId: "main",
        model: "moonshot/kimi-k2.5",
        sessionKey: "agent:main:feishu:dm:ou-user:learning-council:msg-learning-1:kimi",
        thinking: "off",
        timeout: 420,
      }),
    });
    expect(mockCallGateway.mock.calls[1]?.[0]).toMatchObject({
      method: "agent",
      params: expect.objectContaining({
        sessionKey: "agent:main:feishu:dm:ou-user:learning-council:msg-learning-1:deepseek",
        thinking: "medium",
        timeout: 300,
      }),
    });
    expect(mockCallGateway.mock.calls[2]?.[0]).toMatchObject({
      method: "agent",
      params: expect.objectContaining({
        sessionKey: "agent:main:feishu:dm:ou-user:learning-council:msg-learning-1:minimax",
        thinking: "high",
        timeout: 360,
      }),
    });
    expect(mockCallGateway.mock.calls[3]?.[0]).toMatchObject({
      method: "agent",
      params: expect.objectContaining({
        sessionKey: "agent:main:feishu:dm:ou-user:learning-council:msg-learning-1:redteam:minimax",
      }),
    });
    expect(String(mockCallGateway.mock.calls[2]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "## Synthesis lane to audit",
    );
    expect(String(mockCallGateway.mock.calls[2]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "configured role: kimi",
    );
    expect(String(mockCallGateway.mock.calls[2]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "runtime model: moonshot/kimi-k2.5",
    );
    expect(String(mockCallGateway.mock.calls[2]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "long-duration growth is sensitive to rates",
    );
    expect(String(mockCallGateway.mock.calls[2]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "separate valuation pressure from narrative pressure",
    );

    expect(result).toContain("Learning council run: full three-model execution completed.");
    expect(result).toContain("## Kimi synthesis");
    expect(result).toContain(
      "Lane receipt: contract=synthesis (configured role: kimi); runtime provider=moonshot; runtime model=moonshot/kimi-k2.5",
    );
    expect(result).toContain("## MiniMax challenge");
    expect(result).toContain("## DeepSeek extraction");
    expect(result).toContain("## Council consensus");
    expect(result).toContain("### Agreements");
    expect(result).toContain("### Disagreements");
    expect(result).toContain("### Evidence gaps");
    expect(result).toContain("## Follow-up checklist");
    expect(mockRecordOperationalAnomaly).not.toHaveBeenCalled();
  });

  it("uses configured allowlisted council models before legacy built-in defaults", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-learning-council-"));
    const cfg = {
      agents: {
        defaults: {
          models: {
            "minimax-portal/MiniMax-M2.7": {},
            "custom-api-deepseek-com/deepseek-v4-flash": {},
            "custom-api-deepseek-com/deepseek-v4-pro": {},
            "moonshot/kimi-k2.6": {},
          },
        },
      },
    } as ClawdbotConfig;
    mockCallGateway
      .mockResolvedValueOnce({ result: { payloads: [{ text: "kimi ok" }] } })
      .mockResolvedValueOnce({ result: { payloads: [{ text: "deepseek ok" }] } })
      .mockResolvedValueOnce({ result: { payloads: [{ text: "minimax ok" }] } })
      .mockResolvedValueOnce({ result: { payloads: [{ text: "redteam ok" }] } });

    const result = await runFeishuLearningCouncil({
      cfg,
      userMessage: "学习一个低频资产配置研究问题",
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:dm:ou-user",
      messageId: "msg-allowlisted-models",
      workspaceDir,
    });

    expect(mockCallGateway.mock.calls[0]?.[0]).toMatchObject({
      params: expect.objectContaining({ model: "moonshot/kimi-k2.6" }),
    });
    expect(mockCallGateway.mock.calls[1]?.[0]).toMatchObject({
      params: expect.objectContaining({ model: "custom-api-deepseek-com/deepseek-v4-pro" }),
    });
    expect(mockCallGateway.mock.calls[2]?.[0]).toMatchObject({
      params: expect.objectContaining({ model: "minimax-portal/MiniMax-M2.7" }),
    });
    expect(result).not.toContain("Model override");
    expect(result).toMatch(/runtime provider=moonshot; runtime model=moonshot\/kimi-k2\.6/u);
    expect(result).toMatch(
      /runtime provider=custom-api-deepseek-com; runtime model=custom-api-deepseek-com\/deepseek-v4-pro/u,
    );
    expect(result).toMatch(
      /runtime provider=minimax-portal; runtime model=minimax-portal\/MiniMax-M2\.7/u,
    );
  });

  it("persists a bounded learning-council artifact without touching other surface roles", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-learning-council-"));
    mockCallGateway
      .mockResolvedValueOnce({
        result: {
          payloads: [{ text: "## Synthesis\n- rates shape long-duration pressure" }],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            {
              text: "## Candidate lessons\n- separate rates shock from growth improvement\n## Candidate follow-ups\n- verify credit and breadth",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            {
              text: "## What holds up\n- rates matter\n## Challenges\n- driver split still matters\n## Evidence gaps\n- dollar confirmation missing",
            },
          ],
        },
      });

    await runFeishuLearningCouncil({
      cfg: TEST_CFG,
      userMessage: "学一下利率和成长股脆弱性的关系",
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:dm:ou-user",
      messageId: "msg-learning-artifact-1",
      workspaceDir,
    });

    const artifactJsonPath = path.join(
      workspaceDir,
      buildLearningCouncilArtifactJsonRelativePath("msg-learning-artifact-1"),
    );
    const artifactJsonRaw = await fs.readFile(artifactJsonPath, "utf-8");
    const artifactJson = JSON.parse(artifactJsonRaw) as {
      generatedAt: string;
      status: string;
      roles: Array<{ role: string; capability: string; providerFamily: string; model: string }>;
      messageId: string;
    };
    const parsedArtifact = parseLearningCouncilRuntimeArtifact(artifactJsonRaw);
    const artifactMarkdown = await fs.readFile(
      path.join(
        workspaceDir,
        buildLearningCouncilArtifactMarkdownRelativePath("msg-learning-artifact-1"),
      ),
      "utf-8",
    );
    const memoryDir = path.join(workspaceDir, "memory");
    const memoryFiles = await fs.readdir(memoryDir);
    const adoptionLedgerFilename = buildLearningCouncilAdoptionLedgerFilename({
      dateStr: extractIsoDateKey(artifactJson.generatedAt),
      noteSlug: "msg-learning-artifact-1",
    });
    const memoryNote = await fs.readFile(
      path.join(
        memoryDir,
        memoryFiles.find(
          (name) =>
            name ===
            buildLearningCouncilMemoryNoteFilename({
              dateStr: extractIsoDateKey(artifactJson.generatedAt),
              noteSlug: "msg-learning-artifact-1",
            }),
        ) ?? "missing-learning-council-note.md",
      ),
      "utf-8",
    );
    const parsedMemoryNote = parseLearningCouncilMemoryNote({
      filename: buildLearningCouncilMemoryNoteFilename({
        dateStr: extractIsoDateKey(artifactJson.generatedAt),
        noteSlug: "msg-learning-artifact-1",
      }),
      content: memoryNote,
    });
    const adoptionLedger = await fs.readFile(path.join(memoryDir, adoptionLedgerFilename), "utf-8");
    const parsedAdoptionLedger = parseLearningCouncilAdoptionLedger({
      filename: adoptionLedgerFilename,
      content: adoptionLedger,
    });

    expect(artifactJson.messageId).toBe("msg-learning-artifact-1");
    expect(artifactJson.status).toBe("full");
    expect(artifactJson.roles.map((entry) => entry.role)).toEqual(["kimi", "minimax", "deepseek"]);
    expect(artifactJson.roles.map((entry) => entry.capability)).toEqual([
      "synthesis",
      "challenge",
      "extraction",
    ]);
    expect(artifactJson.roles.map((entry) => entry.providerFamily)).toEqual([
      "moonshot",
      "minimax",
      "qianfan",
    ]);
    expect(parsedArtifact?.messageId).toBe("msg-learning-artifact-1");
    expect(parsedArtifact?.status).toBe("full");
    expect(parsedArtifact?.userMessage).toBe("学一下利率和成长股脆弱性的关系");
    expect(parsedArtifact?.runPacket?.objective).toBe("学一下利率和成长股脆弱性的关系");
    expect(parsedArtifact?.runPacket?.protectedAnchorsMissing).toEqual([
      "memory/current-research-line.md",
      "memory/unified-risk-view.md",
      "MEMORY.md",
    ]);
    expect(parsedArtifact?.runPacket?.keepLines).toContain("rates shape long-duration pressure");
    expect(parsedArtifact?.runPacket?.discardLines).toContain("driver split still matters");
    expect(parsedArtifact?.runPacket?.replayTriggerLines).toContain(
      "separate rates shock from growth improvement",
    );
    expect(parsedArtifact?.runPacket?.nextEvalCueLines).toContain("dollar confirmation missing");
    expect(parsedArtifact?.runPacket?.recoveryReadOrder).toContain(
      buildLearningCouncilArtifactJsonRelativePath("msg-learning-artifact-1"),
    );
    expect(parsedArtifact?.runPacket?.recoveryReadOrder).toContain(
      `memory/${buildLearningCouncilMemoryNoteFilename({
        dateStr: extractIsoDateKey(artifactJson.generatedAt),
        noteSlug: "msg-learning-artifact-1",
      })}`,
    );
    expect(parsedArtifact?.runPacket?.recoveryReadOrder).toContain(
      `memory/${buildLearningCouncilAdoptionLedgerFilename({
        dateStr: extractIsoDateKey(artifactJson.generatedAt),
        noteSlug: "msg-learning-artifact-1",
      })}`,
    );
    expect(artifactMarkdown).toContain("## Council consensus");
    expect(memoryNote).toContain("# Learning Council Note: msg-learning-artifact-1");
    expect(memoryNote).toContain("- **Status**: full");
    expect(memoryNote).toContain("- **User Message**: 学一下利率和成长股脆弱性的关系");
    expect(memoryNote).toContain("## Run Packet");
    expect(memoryNote).toContain(
      "- protected_anchors_missing: memory/current-research-line.md, memory/unified-risk-view.md, MEMORY.md",
    );
    expect(parsedMemoryNote?.keeperLines).toContain("rates shape long-duration pressure");
    expect(parsedMemoryNote?.discardLines).toContain("driver split still matters");
    expect(parsedMemoryNote?.rehearsalTriggerLines).toContain(
      "separate rates shock from growth improvement",
    );
    expect(parsedMemoryNote?.nextEvalCueLines).toContain("dollar confirmation missing");
    expect(adoptionLedger).toContain("# Learning Council Adoption Ledger: msg-learning-artifact-1");
    expect(parsedAdoptionLedger?.sourceArtifact).toBe(
      buildLearningCouncilArtifactJsonRelativePath("msg-learning-artifact-1"),
    );
    expect(parsedAdoptionLedger?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cueType: "keep",
          text: "rates shape long-duration pressure",
          adoptedState: "adopted_now",
          reusedLater: false,
          downrankedOrFailed: false,
        }),
        expect.objectContaining({
          cueType: "discard",
          text: "driver split still matters",
          adoptedState: "adopted_now",
        }),
        expect.objectContaining({
          cueType: "replay_trigger",
          text: "separate rates shock from growth improvement",
          adoptedState: "candidate_for_reuse",
        }),
        expect.objectContaining({
          cueType: "next_eval",
          text: "dollar confirmation missing",
          adoptedState: "candidate_for_reuse",
        }),
      ]),
    );
  });

  it("flags mutable numeric facts as low-fidelity and records a hallucination-risk anomaly", async () => {
    mockCallGateway
      .mockResolvedValueOnce({
        result: {
          payloads: [
            {
              text: "## Synthesis\n- the repo now has 123,456 stars and release 2.4.1\n## Freshness and caveats\n- source still being checked",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            {
              text: "## Candidate lessons\n- verify mutable facts first\n## Candidate follow-ups\n- check the GitHub primary page\n## Weak evidence\n- current release line may be stale",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            {
              text: "## What holds up\n- repo activity matters\n## Challenges\n- mutable figures may be stale\n## Evidence gaps\n- primary-source verification still missing",
            },
          ],
        },
      });

    const result = await runFeishuLearningCouncil({
      cfg: TEST_CFG,
      userMessage: "学一下这个 GitHub 项目值不值得跟",
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:dm:ou-user",
      messageId: "msg-learning-mutable-facts",
    });

    expect(result).toContain(
      "Learning council run: full three-model execution completed with low-fidelity fact warnings.",
    );
    expect(result).toContain("### Reliability note");
    expect(result).toContain("mutable facts may still be under-verified in this turn");
    expect(mockRecordOperationalAnomaly).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "hallucination_risk",
        source: "feishu.learning_command",
      }),
    );
  });

  it("records an anomaly and labels the output degraded when one role fails", async () => {
    mockCallGateway
      .mockResolvedValueOnce({
        result: {
          payloads: [{ text: "## Synthesis\n- one working point" }],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [{ text: "## Candidate follow-ups\n- check one source" }],
        },
      })
      .mockRejectedValueOnce(new Error("minimax unavailable"));

    const result = await runFeishuLearningCouncil({
      cfg: TEST_CFG,
      userMessage: "学一下新的 agent 平台和金融技术",
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:dm:ou-user",
      messageId: "msg-learning-2",
    });

    expect(result).toContain("Learning council run: partial / degraded execution.");
    expect(result).toContain("## MiniMax challenge");
    expect(result).toContain("run_failed: Error: minimax unavailable");
    expect(result).toContain("partial council only");
    expect(mockRecordOperationalAnomaly).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "learning_quality_drift",
        source: "feishu.learning_command",
      }),
    );
  });

  it("lets another role rescue the council when MiniMax fails so consensus still has challenge coverage", async () => {
    mockCallGateway
      .mockResolvedValueOnce({
        result: {
          payloads: [{ text: "## Synthesis\n- one working point" }],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            {
              text: "## Candidate lessons\n- one lesson\n## Candidate follow-ups\n- check one source",
            },
          ],
        },
      })
      .mockRejectedValueOnce(new Error("minimax unavailable"))
      .mockResolvedValueOnce({
        result: {
          payloads: [
            {
              text: "## What holds up\n- the core framing still holds\n## Challenges\n- macro driver split still unresolved\n## Evidence gaps\n- breadth confirmation still missing",
            },
          ],
        },
      });

    const result = await runFeishuLearningCouncil({
      cfg: TEST_CFG,
      userMessage: "学一下一个普通主题，但如果有人失败了就让其他角色补位",
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:dm:ou-user",
      messageId: "msg-learning-rescue-minimax",
    });

    expect(result).toContain(
      "rescue_coverage: deepseek supplied a fallback contribution for minimax",
    );
    expect(result).toContain("fallback rescue coverage: minimax<=deepseek");
    expect(result).toContain("macro driver split still unresolved");
    expect(result).toContain("breadth confirmation still missing");
  });

  it("records a write-edit anomaly when artifact persistence cannot resolve a workspace", async () => {
    mockCallGateway
      .mockResolvedValueOnce({
        result: {
          payloads: [{ text: "## Synthesis\n- one working point" }],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [{ text: "## Candidate lessons\n- one lesson" }],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [{ text: "## What holds up\n- one point" }],
        },
      });

    const result = await runFeishuLearningCouncil({
      cfg: TEST_CFG,
      userMessage: "学一下一个主题",
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:dm:ou-user",
      messageId: "msg-learning-no-workspace",
    });

    expect(result).toContain("Learning council run: full three-model execution completed.");
    expect(mockRecordOperationalAnomaly).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "write_edit_failure",
        source: "feishu.learning_command",
      }),
    );
  });

  it("runs an extra MiniMax red-team pass when the user explicitly asks for MiniMax challenge pressure", async () => {
    mockCallGateway
      .mockResolvedValueOnce({
        result: {
          payloads: [{ text: "## Synthesis\n- rates pressure long-duration assets" }],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            {
              text: "## Candidate lessons\n- separate valuation pressure from growth pressure\n## Candidate follow-ups\n- verify credit and dollar",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            {
              text: "## What holds up\n- rates still matter\n## Challenges\n- not every rate rise is bearish\n## Evidence gaps\n- breadth still missing",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            {
              text: "## What holds up\n- the duration link is real\n## Challenges\n- the regime driver is still underspecified\n## Evidence gaps\n- credit stress path still unverified",
            },
          ],
        },
      });

    const result = await runFeishuLearningCouncil({
      cfg: TEST_CFG,
      userMessage: "用三个模型学一下这个题目，让 MiniMax 多挑刺再审一轮",
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:dm:ou-user",
      messageId: "msg-learning-minimax-heavy",
    });

    expect(mockCallGateway).toHaveBeenCalledTimes(4);
    expect(mockCallGateway.mock.calls[2]?.[0]).toMatchObject({
      method: "agent",
      params: expect.objectContaining({
        sessionKey:
          "agent:main:feishu:dm:ou-user:learning-council:msg-learning-minimax-heavy:minimax",
      }),
    });
    expect(mockCallGateway.mock.calls[3]?.[0]).toMatchObject({
      method: "agent",
      params: expect.objectContaining({
        sessionKey:
          "agent:main:feishu:dm:ou-user:learning-council:msg-learning-minimax-heavy:redteam:minimax",
      }),
    });
    expect(String(mockCallGateway.mock.calls[3]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "increase red-team pressure",
    );
    expect(result).toContain("## Extra red-team pass");
    expect(result).toContain("the regime driver is still underspecified");
  });

  it("records the actual runtime provider and model when a council lane is overridden to another vendor", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-learning-council-"));
    process.env.OPENCLAW_LEARNING_COUNCIL_MINIMAX_MODEL = "openai/gpt-5.4";
    mockCallGateway
      .mockResolvedValueOnce({
        result: { payloads: [{ text: "## Synthesis\n- one" }] },
      })
      .mockResolvedValueOnce({
        result: { payloads: [{ text: "## Candidate lessons\n- two" }] },
      })
      .mockResolvedValueOnce({
        result: { payloads: [{ text: "## What holds up\n- three" }] },
      });

    const result = await runFeishuLearningCouncil({
      cfg: TEST_CFG,
      userMessage: "学一下这个系统架构",
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:dm:ou-user",
      messageId: "msg-learning-minimax-override",
      workspaceDir,
    });

    expect(mockCallGateway.mock.calls[2]?.[0]).toMatchObject({
      method: "agent",
      params: expect.objectContaining({
        model: "openai/gpt-5.4",
      }),
    });
    expect(String(mockCallGateway.mock.calls[2]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "Treat MiniMax as a stable lane label, not as proof of the runtime provider identity.",
    );
    expect(
      String(mockCallGateway.mock.calls[2]?.[0]?.params?.extraSystemPrompt ?? ""),
    ).not.toContain("You are MiniMax in a learning council.");
    expect(result).toContain("## MiniMax challenge");
    expect(result).toContain(
      "Lane receipt: contract=challenge (configured role: minimax); runtime provider=openai; runtime model=openai/gpt-5.4",
    );

    const artifactJsonPath = path.join(
      workspaceDir,
      buildLearningCouncilArtifactJsonRelativePath("msg-learning-minimax-override"),
    );
    const artifactJsonRaw = await fs.readFile(artifactJsonPath, "utf-8");
    const artifactJson = JSON.parse(artifactJsonRaw) as {
      roles: Array<{ role: string; providerFamily: string; model: string }>;
    };
    expect(artifactJson.roles[1]).toMatchObject({
      role: "minimax",
      providerFamily: "openai",
      model: "openai/gpt-5.4",
    });
  });

  it("falls back to the global MiniMax default model seam when no learning-council override is set", async () => {
    process.env.OPENCLAW_MINIMAX_DEFAULT_MODEL = "MiniMax-M2.7";
    mockCallGateway
      .mockResolvedValueOnce({
        result: { payloads: [{ text: "## Synthesis\n- one" }] },
      })
      .mockResolvedValueOnce({
        result: { payloads: [{ text: "## Candidate lessons\n- two" }] },
      })
      .mockResolvedValueOnce({
        result: { payloads: [{ text: "## What holds up\n- three" }] },
      });

    await runFeishuLearningCouncil({
      cfg: TEST_CFG,
      userMessage: "学一下这个系统架构",
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:dm:ou-user",
      messageId: "msg-learning-minimax-default-override",
    });

    expect(mockCallGateway.mock.calls[2]?.[0]).toMatchObject({
      method: "agent",
      params: expect.objectContaining({
        model: "minimax/MiniMax-M2.7",
      }),
    });
  });

  it("strengthens the Kimi synthesis prompt when the user explicitly asks Kimi to lead the study", async () => {
    mockCallGateway
      .mockResolvedValueOnce({
        result: {
          payloads: [{ text: "## Synthesis\n- one\n## Freshness and caveats\n- two" }],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            { text: "## Candidate lessons\n- lesson\n## Candidate follow-ups\n- follow-up" },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            { text: "## What holds up\n- ok\n## Challenges\n- caveat\n## Evidence gaps\n- gap" },
          ],
        },
      });

    await runFeishuLearningCouncil({
      cfg: TEST_CFG,
      userMessage: "让 Kimi 先深挖原理，再给我 learning council 结果",
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:dm:ou-user",
      messageId: "msg-learning-kimi-heavy",
    });

    expect(String(mockCallGateway.mock.calls[0]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "5 to 7 concise bullets",
    );
    expect(String(mockCallGateway.mock.calls[0]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "spend extra effort on mechanism clarity",
    );
  });

  it("automatically applies Kimi-heavy and MiniMax-heavy mode for high-value quant and agent learning topics", async () => {
    mockCallGateway
      .mockResolvedValueOnce({
        result: {
          payloads: [{ text: "## Synthesis\n- one\n## Freshness and caveats\n- two" }],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            { text: "## Candidate lessons\n- lesson\n## Candidate follow-ups\n- follow-up" },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            { text: "## What holds up\n- ok\n## Challenges\n- caveat\n## Evidence gaps\n- gap" },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            { text: "## What holds up\n- ok2\n## Challenges\n- caveat2\n## Evidence gaps\n- gap2" },
          ],
        },
      });

    await runFeishuLearningCouncil({
      cfg: TEST_CFG,
      userMessage: "去学开源的新金融策略、金融技术，还有同类 agent platform",
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:dm:ou-user",
      messageId: "msg-learning-high-value-topic",
    });

    expect(mockCallGateway).toHaveBeenCalledTimes(4);
    expect(String(mockCallGateway.mock.calls[0]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "5 to 7 concise bullets",
    );
    expect(String(mockCallGateway.mock.calls[3]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "increase red-team pressure",
    );
  });

  it("treats bilingual Chinese-English understanding as a high-value learning topic", async () => {
    mockCallGateway
      .mockResolvedValueOnce({
        result: {
          payloads: [
            {
              text: "## Synthesis\n- map finance and workflow terms across Chinese and English\n## Freshness and caveats\n- narrow source set",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            {
              text: "## Candidate lessons\n- keep trigger phrases paired\n## Candidate follow-ups\n- verify ambiguous terms",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            {
              text: "## What holds up\n- bilingual trigger mapping helps\n## Challenges\n- literal translation still breaks intent\n## Evidence gaps\n- false friends still under-tested",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            {
              text: "## What holds up\n- second audit\n## Challenges\n- more ambiguity risk\n## Evidence gaps\n- more coverage needed",
            },
          ],
        },
      });

    await runFeishuLearningCouncil({
      cfg: TEST_CFG,
      userMessage: "单独让龙虾烧 token 学中英双语理解、术语映射和自然语言 workflow 触发词",
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:dm:ou-user",
      messageId: "msg-learning-bilingual",
    });

    expect(mockCallGateway).toHaveBeenCalledTimes(4);
    expect(String(mockCallGateway.mock.calls[0]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "bilingual language understanding and workflow comprehension",
    );
    expect(String(mockCallGateway.mock.calls[2]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "literal translation traps",
    );
  });

  it("treats DS/statistics timing-method study as a high-value learning topic", async () => {
    mockCallGateway
      .mockResolvedValueOnce({
        result: {
          payloads: [{ text: "## Synthesis\n- one\n## Freshness and caveats\n- two" }],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            { text: "## Candidate lessons\n- lesson\n## Candidate follow-ups\n- follow-up" },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            { text: "## What holds up\n- ok\n## Challenges\n- caveat\n## Evidence gaps\n- gap" },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            { text: "## What holds up\n- ok2\n## Challenges\n- caveat2\n## Evidence gaps\n- gap2" },
          ],
        },
      });

    await runFeishuLearningCouncil({
      cfg: TEST_CFG,
      userMessage:
        "我是学ds统计的中国散户，想把回归、样本外验证、bootstrap 和显著性检验用到 ETF 择时上，你去学一下最值得我反复记住的框架",
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:dm:ou-user",
      messageId: "msg-learning-ds-stat-topic",
    });

    expect(mockCallGateway).toHaveBeenCalledTimes(4);
    expect(String(mockCallGateway.mock.calls[0]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "5 to 7 concise bullets",
    );
    expect(String(mockCallGateway.mock.calls[3]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "increase red-team pressure",
    );
  });

  it("treats LLM-finance-agent article learning as a high-value learning topic", async () => {
    mockCallGateway
      .mockResolvedValueOnce({
        result: {
          payloads: [{ text: "## Synthesis\n- one\n## Freshness and caveats\n- two" }],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            { text: "## Candidate lessons\n- lesson\n## Candidate follow-ups\n- follow-up" },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            { text: "## What holds up\n- ok\n## Challenges\n- caveat\n## Evidence gaps\n- gap" },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            { text: "## What holds up\n- ok2\n## Challenges\n- caveat2\n## Evidence gaps\n- gap2" },
          ],
        },
      });

    await runFeishuLearningCouncil({
      cfg: TEST_CFG,
      userMessage: "去读关于llm应用在金融智能体上的文章，对你自我提升的启发",
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:dm:ou-user",
      messageId: "msg-learning-llm-finance-agent-topic",
    });

    expect(mockCallGateway).toHaveBeenCalledTimes(4);
    expect(String(mockCallGateway.mock.calls[0]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "5 to 7 concise bullets",
    );
    expect(String(mockCallGateway.mock.calls[3]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "increase red-team pressure",
    );
  });

  it("forces internalization-focused learning for GitHub open-source skill asks", async () => {
    mockCallGateway
      .mockResolvedValueOnce({
        result: {
          payloads: [{ text: "## Synthesis\n- one\n## Freshness and caveats\n- two" }],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            { text: "## Candidate lessons\n- lesson\n## Candidate follow-ups\n- follow-up" },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            { text: "## What holds up\n- ok\n## Challenges\n- caveat\n## Evidence gaps\n- gap" },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            { text: "## What holds up\n- ok2\n## Challenges\n- caveat2\n## Evidence gaps\n- gap2" },
          ],
        },
      });

    await runFeishuLearningCouncil({
      cfg: TEST_CFG,
      userMessage: "去github上学习开源的值得你学的，并把值得内化的内化",
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:dm:ou-user",
      messageId: "msg-learning-github-internalize",
    });

    expect(mockCallGateway).toHaveBeenCalledTimes(3);
    expect(String(mockCallGateway.mock.calls[0]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "Prioritize only what Lobster should internalize into reusable operating rules",
    );
    expect(String(mockCallGateway.mock.calls[0]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "Finance mainline comes first.",
    );
    expect(String(mockCallGateway.mock.calls[0]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "Explicitly discard hype, surface novelty, or generic best-practice fluff",
    );
    expect(String(mockCallGateway.mock.calls[1]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "Only promote lessons that are worth durable internalization into Lobster's future judgment",
    );
    expect(String(mockCallGateway.mock.calls[1]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "Finance mainline comes first.",
    );
    expect(String(mockCallGateway.mock.calls[2]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "what should Lobster really keep, what should it explicitly discard, and what changes now",
    );
    expect(String(mockCallGateway.mock.calls[2]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "Finance mainline comes first.",
    );
  });

  it("rejects shallow survey summaries when the user asks for internalizable takeaways only", async () => {
    mockCallGateway
      .mockResolvedValueOnce({
        result: {
          payloads: [{ text: "## Synthesis\n- one\n## Freshness and caveats\n- two" }],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            { text: "## Candidate lessons\n- lesson\n## Candidate follow-ups\n- follow-up" },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            { text: "## What holds up\n- ok\n## Challenges\n- caveat\n## Evidence gaps\n- gap" },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            { text: "## What holds up\n- ok2\n## Challenges\n- caveat2\n## Evidence gaps\n- gap2" },
          ],
        },
      });

    await runFeishuLearningCouncil({
      cfg: TEST_CFG,
      userMessage:
        "去看最近开源agent都怎么做长期记忆，然后只告诉我哪些真的值得你自己内化，别做表面总结",
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:dm:ou-user",
      messageId: "msg-learning-internalize-no-shallow-summary",
    });

    expect(mockCallGateway).toHaveBeenCalledTimes(3);
    expect(String(mockCallGateway.mock.calls[0]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "Do not give a broad survey-style summary",
    );
    expect(String(mockCallGateway.mock.calls[0]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "Finance mainline comes first.",
    );
    expect(String(mockCallGateway.mock.calls[1]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "Do not produce a broad ecosystem recap",
    );
    expect(String(mockCallGateway.mock.calls[1]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "Finance mainline comes first.",
    );
    expect(String(mockCallGateway.mock.calls[2]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "Penalize broad survey language, vague ecosystem recap, and generic inspirational summaries",
    );
    expect(String(mockCallGateway.mock.calls[2]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "Finance mainline comes first.",
    );
  });

  it("treats Hermes install and memory-provider study as bounded broad-knowledge distillation for Lobster adoption", async () => {
    mockCallGateway
      .mockResolvedValueOnce({
        result: {
          payloads: [{ text: "## Synthesis\n- one\n## Freshness and caveats\n- two" }],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            { text: "## Candidate lessons\n- lesson\n## Candidate follow-ups\n- follow-up" },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            { text: "## What holds up\n- ok\n## Challenges\n- caveat\n## Evidence gaps\n- gap" },
          ],
        },
      });

    await runFeishuLearningCouncil({
      cfg: TEST_CFG,
      userMessage:
        "去 github 上看看 Hermes-agent 的安装、context files 和 memory providers，学那些真值得龙虾自己接进来的，别做 agent 圈综述",
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:dm:ou-user",
      messageId: "msg-learning-hermes-adoption",
    });

    expect(mockCallGateway).toHaveBeenCalledTimes(3);
    expect(String(mockCallGateway.mock.calls[0]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "Broad knowledge distillation mode is active.",
    );
    expect(String(mockCallGateway.mock.calls[0]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "what Lobster should adopt now, what to skip, what compatibility risk to watch, and one next patch or install step it can verify locally",
    );
    expect(String(mockCallGateway.mock.calls[1]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "install or migration follow-ups, and compatibility notes",
    );
    expect(String(mockCallGateway.mock.calls[2]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "Attack recommendations that require wholesale migration, vendor lock-in, or broad architecture replacement",
    );
    expect(String(mockCallGateway.mock.calls[2]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "Rule out ecosystem tourism",
    );
  });

  it("adds keep-discard-rehearsal-eval discipline to self-improvement learning topics", async () => {
    mockCallGateway
      .mockResolvedValueOnce({
        result: {
          payloads: [{ text: "## Synthesis\n- one\n## Freshness and caveats\n- two" }],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            { text: "## Candidate lessons\n- lesson\n## Candidate follow-ups\n- follow-up" },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            { text: "## What holds up\n- ok\n## Challenges\n- caveat\n## Evidence gaps\n- gap" },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            { text: "## What holds up\n- ok2\n## Challenges\n- caveat2\n## Evidence gaps\n- gap2" },
          ],
        },
      });

    await runFeishuLearningCouncil({
      cfg: TEST_CFG,
      userMessage: "去读关于llm应用在金融智能体上的文章，对你自我提升的启发",
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:dm:ou-user",
      messageId: "msg-learning-distill-discipline",
    });

    expect(mockCallGateway).toHaveBeenCalledTimes(4);
    expect(String(mockCallGateway.mock.calls[0]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "## Distilled keepers",
    );
    expect(String(mockCallGateway.mock.calls[0]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "## Replay triggers",
    );
    expect(String(mockCallGateway.mock.calls[1]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "## Distillation-ready rules",
    );
    expect(String(mockCallGateway.mock.calls[2]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "## What to discard",
    );
    expect(String(mockCallGateway.mock.calls[2]?.[0]?.params?.extraSystemPrompt ?? "")).toContain(
      "## Replay failure checks",
    );
  });

  it("renders a distilled operating pack for durable-learning topics instead of stopping at summary prose", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-learning-council-"));
    mockCallGateway
      .mockResolvedValueOnce({
        result: {
          payloads: [
            {
              text: [
                "## Synthesis",
                "- agent learning should reduce repeat failure, not just add features",
                "## Freshness and caveats",
                "- current examples still need same-turn verification",
                "## Provisional anchors",
                "- receipts and replay-safe workflow matter",
                "## Distilled keepers",
                "- Keep a small set of reusable rules instead of broad ecosystem summaries.",
                "- Always separate what changes Lobster now from what is merely interesting.",
                "## Replay triggers",
                "- Reopen this lesson when a new agent pattern sounds exciting but lacks an eval.",
              ].join("\n"),
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            {
              text: [
                "## Candidate lessons",
                "- Turn lessons into short reusable rules rather than long summaries.",
                "## Candidate follow-ups",
                "- Compare the new rule against one recent Lobster failure before promoting it.",
                "## Weak evidence",
                "- hosted memory vendors still need bounded trust.",
                "## Distillation-ready rules",
                "- If a learning output cannot name a future behavior change, keep it provisional.",
                "## Replay triggers",
                "- Trigger a replay when a new memory/system idea cannot survive one operator-style red-team pass.",
              ].join("\n"),
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            {
              text: [
                "## What holds up",
                "- durable learning needs replay cues and falsification hooks, not just summaries.",
                "## Challenges",
                "- do not keep broad ecosystem claims that never change workflow behavior.",
                "## Evidence gaps",
                "- this rule still needs one real Lobster failure-case comparison.",
                "## What to discard",
                "- Discard generic 'best practices' that do not survive into one concrete rule.",
                "## Replay failure checks",
                "- Revisit the rule if the next similar learning run still produces only recap prose.",
              ].join("\n"),
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            {
              text: [
                "## What holds up",
                "- the keep/discard split is real",
                "## Challenges",
                "- some examples are still trend-driven",
                "## Evidence gaps",
                "- one live acceptance phrase is still missing",
                "## What to discard",
                "- discard novelty-only examples that do not survive reuse pressure",
                "## Replay failure checks",
                "- rerun this lesson if the next operator complaint shows the same old behavior",
              ].join("\n"),
            },
          ],
        },
      });

    const result = await runFeishuLearningCouncil({
      cfg: TEST_CFG,
      userMessage: "去github上学习开源的值得你学的，并把值得内化的内化",
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:dm:ou-user",
      messageId: "msg-learning-distilled-pack",
      workspaceDir,
    });

    expect(result).toContain("## Distilled operating pack");
    expect(result).toContain("### Keep");
    expect(result).toContain("### Discard or downrank");
    expect(result).toContain("### Rehearsal triggers");
    expect(result).toContain("### Next eval cue");
    expect(result).toContain(
      "Keep a small set of reusable rules instead of broad ecosystem summaries.",
    );
    expect(result).toContain(
      "Discard generic 'best practices' that do not survive into one concrete rule.",
    );
    expect(result).toContain(
      "Reopen this lesson when a new agent pattern sounds exciting but lacks an eval.",
    );
    expect(result).toContain(
      "Compare the new rule against one recent Lobster failure before promoting it.",
    );
    const memoryDir = path.join(workspaceDir, "memory");
    const memoryFiles = await fs.readdir(memoryDir);
    const noteName =
      memoryFiles.find((name) =>
        name.endsWith("-learning-council-msg-learning-distilled-pack.md"),
      ) ?? "missing-learning-council-note.md";
    const parsedMemoryNote = parseLearningCouncilMemoryNote({
      filename: noteName,
      content: await fs.readFile(path.join(memoryDir, noteName), "utf-8"),
    });
    expect(parsedMemoryNote?.keeperLines).toContain(
      "Keep a small set of reusable rules instead of broad ecosystem summaries.",
    );
    expect(parsedMemoryNote?.discardLines).toContain(
      "Discard generic 'best practices' that do not survive into one concrete rule.",
    );
    expect(parsedMemoryNote?.rehearsalTriggerLines).toContain(
      "Reopen this lesson when a new agent pattern sounds exciting but lacks an eval.",
    );
    expect(parsedMemoryNote?.nextEvalCueLines).toContain(
      "Compare the new rule against one recent Lobster failure before promoting it.",
    );
  });

  it("adds a source-coverage reliability note when a role reports search-limited learning", async () => {
    mockCallGateway
      .mockResolvedValueOnce({
        result: {
          payloads: [
            {
              text: "## Synthesis\n- one working point\n## Freshness and caveats\n- 网络搜索暂时不可用，source coverage is narrow",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            {
              text: "## Candidate lessons\n- one lesson\n## Candidate follow-ups\n- one follow-up",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            {
              text: "## What holds up\n- one point\n## Challenges\n- one challenge\n## Evidence gaps\n- one gap",
            },
          ],
        },
      });

    const result = await runFeishuLearningCouncil({
      cfg: TEST_CFG,
      userMessage: "去学一下最近国外网站和中文网站上关于金融技术的内容",
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:dm:ou-user",
      messageId: "msg-learning-coverage",
    });

    expect(result).toContain("source coverage looked narrow or search-limited in this turn");
    expect(mockRecordOperationalAnomaly).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "provider_degradation",
        source: "feishu.learning_command",
      }),
    );
  });

  it("keeps a normal single MiniMax audit for non-priority generic learning asks", async () => {
    mockCallGateway
      .mockResolvedValueOnce({
        result: {
          payloads: [{ text: "## Synthesis\n- one\n## Freshness and caveats\n- two" }],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            { text: "## Candidate lessons\n- lesson\n## Candidate follow-ups\n- follow-up" },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            { text: "## What holds up\n- ok\n## Challenges\n- caveat\n## Evidence gaps\n- gap" },
          ],
        },
      });

    await runFeishuLearningCouncil({
      cfg: TEST_CFG,
      userMessage: "学一下这个普通主题，顺手总结一下",
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:dm:ou-user",
      messageId: "msg-learning-generic-topic",
    });

    expect(mockCallGateway).toHaveBeenCalledTimes(3);
  });

  it("anchors finance-learning council prompts on the current research line and latest carryover cue", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-learning-council-"));
    const memoryDir = path.join(workspaceDir, "memory");
    const localMemoryDir = path.join(memoryDir, "local-memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.mkdir(localMemoryDir, { recursive: true });
    await fs.writeFile(
      path.join(memoryDir, "current-research-line.md"),
      [
        "# Current Research Line",
        "",
        "current_focus: holdings_revalidation_finance_mainline",
        "top_decision: keep finance learning tied to old-thesis revalidation and the seven decision foundations",
        "next_step: study finance methods that improve holdings analysis before broadening into meta-agent topics",
        "guardrail: research-only memory; no generic super-agent drift",
        "recall_order: current-research-line -> portfolio-sizing-discipline-template -> risk-transmission-template -> outcome-review-template",
        "",
        "## Continuous Improvement",
        "",
        "- lesson_fit_rule: only keep a lesson if it sharpens holdings analysis, sizing discipline, or risk control",
      ].join("\n"),
      "utf-8",
    );
    await fs.writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      [
        "# MEMORY",
        "",
        "## What Lobster Is",
        "- Lobster is a low-frequency finance research operating system for one real user.",
        "- Mainline scope is full finance research below the high-frequency line: ETF, major-asset, watchlist, macro, timing, screening, conviction, risk review, and company research.",
        "",
        "## What Must Be Preserved",
        "- The distillation chain must serve both Lobster's general agent meta-capability and the full finance research pipeline.",
        "- The learning, frontier, fundamental, and operating hook families stay as the main internal workflow spine.",
        "",
        "## Active Workflow Families",
        "- Fundamental research: run the company and issuer pipeline from intake to manifest, readiness, snapshot, scoring, risk handoff, review, and deliverables.",
        "",
        "## Current Upgrade Direction",
        "- Keep the distillation chain serving both general agent meta-capability and the full finance research pipeline.",
      ].join("\n"),
      "utf-8",
    );
    await fs.writeFile(
      path.join(localMemoryDir, "workflow-protected-summary-first-recall-order.md"),
      [
        "# Local Memory Card",
        "",
        "- subject: Protected summary first recall order",
        "- status: active",
        "- updated_at: 2026-04-10T12:00:00.000Z",
        "",
        "## Current Summary",
        "When current-state truth matters, start from current-research-line, unified-risk-view when present, and MEMORY.md before broad recall.",
        "",
        "## Use This Card When",
        "Use when a learning or analysis run risks jumping into broad recall before protected summaries.",
        "",
        "## First Narrowing Step",
        "Read current-research-line and MEMORY.md before any broader artifact sweep.",
      ].join("\n"),
      "utf-8",
    );
    await fs.writeFile(
      path.join(localMemoryDir, "holding-holdings-thesis-revalidation.md"),
      [
        "# Local Memory Card",
        "",
        "- subject: Holdings thesis revalidation",
        "- status: active",
        "- updated_at: 2026-04-10T12:01:00.000Z",
        "",
        "## Current Summary",
        "Before saying hold, add, reduce, or exit, retrieve the old thesis, current research line, latest carryover cue, and correction trail.",
        "",
        "## Use This Card When",
        "Use when the current objective touches holdings analysis, old thesis survival, or position-level finance judgment.",
        "",
        "## First Narrowing Step",
        "Narrow first on the old thesis, current anchor, latest carryover cue, and correction trail.",
      ].join("\n"),
      "utf-8",
    );
    await fs.writeFile(
      path.join(localMemoryDir, "workflow-unrelated-latest-card.md"),
      [
        "# Local Memory Card",
        "",
        "- subject: Unrelated latest card",
        "- status: active",
        "- updated_at: 2026-04-10T12:09:00.000Z",
        "",
        "## Current Summary",
        "This card is newer but should not be loaded for holdings-finance learning.",
        "",
        "## Use This Card When",
        "Use only for an unrelated non-finance setup path.",
      ].join("\n"),
      "utf-8",
    );
    await fs.writeFile(
      path.join(memoryDir, "2026-04-09-lobster-workface.md"),
      [
        "# Lobster Workface: 2026-04-09",
        "",
        "## Yesterday Learned",
        "- keep: keep macro and position lessons tied to prior thesis review, not fresh storytelling.",
        "- discard: discard generic finance-agent feature lists that do not improve holdings judgment.",
        "- replay: replay this cue when the next holdings-thesis revalidation ask arrives.",
        "- next eval: next batch verify the learning improves one real holdings brief.",
      ].join("\n"),
      "utf-8",
    );
    mockCallGateway
      .mockResolvedValueOnce({
        result: {
          payloads: [
            {
              text: "## Synthesis\n- one\n## Freshness and caveats\n- two\n## Lobster improvement\n- tighten the first-pass task bracket before broad finance synthesis",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            {
              text: "## Candidate lessons\n- lesson\n## Candidate follow-ups\n- follow-up\n## Lobster improvement\n- persist one bounded improvement cue into daily workface instead of leaving it in council prose",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            {
              text: "## What holds up\n- ok\n## Challenges\n- caveat\n## Evidence gaps\n- gap\n## Lobster improvement\n- add a finance-first failure guard when broad agent-pattern learning starts drifting into generic architecture talk\n## Ruled out\n- fresh finance storytelling without old-thesis recovery\n## Highest-information next checks\n- follow-up",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            {
              text: "## What holds up\n- ok2\n## Challenges\n- caveat2\n## Evidence gaps\n- gap2\n## Lobster improvement\n- keep the improvement cue bounded to one next patch, not a broad rewrite\n## Ruled out\n- generic meta-agent recap as the primary output for this ask",
            },
          ],
        },
      });

    const reply = await runFeishuLearningCouncil({
      cfg: TEST_CFG,
      userMessage: "去学金融领域里最值得内化的部分，后面要帮我做持仓分析",
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:dm:ou-user",
      messageId: "msg-learning-finance-anchored",
      workspaceDir,
    });

    expect(reply).toContain("### Lobster improvement feedback");
    expect(reply).toContain("tighten the first-pass task bracket before broad finance synthesis");
    expect(reply).toContain(
      "persist one bounded improvement cue into daily workface instead of leaving it in council prose",
    );
    expect(reply).toContain(
      "add a finance-first failure guard when broad agent-pattern learning starts drifting into generic architecture talk",
    );

    const lanePrompts = mockCallGateway.mock.calls
      .slice(0, 3)
      .map((call) => String(call?.[0]?.params?.extraSystemPrompt ?? ""));
    for (const prompt of lanePrompts) {
      expect(prompt).toContain("present protected anchors: memory/current-research-line.md");
      expect(prompt).toContain("current focus: holdings_revalidation_finance_mainline");
      expect(prompt).toContain(
        "top decision: keep finance learning tied to old-thesis revalidation and the seven decision foundations",
      );
      expect(prompt).toContain(
        "lesson-fit rule: only keep a lesson if it sharpens holdings analysis, sizing discipline, or risk control",
      );
      expect(prompt).toContain("## Workspace finance brain index");
      expect(prompt).toContain(
        "Lobster is a low-frequency finance research operating system for one real user.",
      );
      expect(prompt).toContain(
        "preserve: The distillation chain must serve both Lobster's general agent meta-capability and the full finance research pipeline.",
      );
      expect(prompt).toContain("## Local durable memory cards");
      expect(prompt).toContain("Holdings thesis revalidation [active]:");
      expect(prompt).toContain(
        "when: Use when the current objective touches holdings analysis, old thesis survival, or position-level finance judgment.",
      );
      expect(prompt).toContain(
        "first step: Narrow first on the old thesis, current anchor, latest carryover cue, and correction trail.",
      );
      expect(prompt).toContain("Protected summary first recall order [active]:");
      expect(prompt).toContain(
        "when: Use when a learning or analysis run risks jumping into broad recall before protected summaries.",
      );
      expect(prompt).not.toContain("Unrelated latest card [active]:");
      expect(prompt).toContain("source: memory/2026-04-09-lobster-workface.md");
      expect(prompt).toContain(
        "- retain: keep macro and position lessons tied to prior thesis review, not fresh storytelling.",
      );
      expect(prompt).toContain(
        "- next eval: next batch verify the learning improves one real holdings brief.",
      );
      expect(prompt).toContain("## Lobster improvement");
    }

    const artifactJsonRaw = await fs.readFile(
      path.join(
        workspaceDir,
        buildLearningCouncilArtifactJsonRelativePath("msg-learning-finance-anchored"),
      ),
      "utf-8",
    );
    const parsedArtifact = parseLearningCouncilRuntimeArtifact(artifactJsonRaw);
    expect(parsedArtifact?.runPacket?.protectedAnchorsPresent).toEqual([
      "memory/current-research-line.md",
      "MEMORY.md",
    ]);
    expect(parsedArtifact?.runPacket?.currentFocus).toBe("holdings_revalidation_finance_mainline");
    expect(parsedArtifact?.runPacket?.latestCarryoverSource).toBe(
      "memory/2026-04-09-lobster-workface.md",
    );
    expect(parsedArtifact?.runPacket?.localMemoryCardPaths).toEqual([
      "memory/local-memory/holding-holdings-thesis-revalidation.md",
      "memory/local-memory/workflow-protected-summary-first-recall-order.md",
    ]);
    expect(parsedArtifact?.runPacket?.lobsterImprovementLines).toEqual([
      "tighten the first-pass task bracket before broad finance synthesis",
      "persist one bounded improvement cue into daily workface instead of leaving it in council prose",
      "add a finance-first failure guard when broad agent-pattern learning starts drifting into generic architecture talk",
      "keep the improvement cue bounded to one next patch, not a broad rewrite",
    ]);
    expect(parsedArtifact?.runPacket?.currentBracketLines).toEqual(["one"]);
    expect(parsedArtifact?.runPacket?.ruledOutLines).toEqual([
      "fresh finance storytelling without old-thesis recovery",
      "generic meta-agent recap as the primary output for this ask",
      "caveat",
      "caveat2",
    ]);
    expect(parsedArtifact?.runPacket?.highestInfoNextCheckLines).toEqual(["follow-up"]);
    expect(parsedArtifact?.runPacket?.recoveryReadOrder.slice(0, 4)).toEqual([
      "memory/current-research-line.md",
      "MEMORY.md",
      "memory/2026-04-09-lobster-workface.md",
      "memory/local-memory/holding-holdings-thesis-revalidation.md",
    ]);
  });

  it("makes missing anchor state explicit instead of pretending finance learning is already aligned", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-learning-council-"));
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    mockCallGateway
      .mockResolvedValueOnce({
        result: {
          payloads: [{ text: "## Synthesis\n- one\n## Freshness and caveats\n- two" }],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            { text: "## Candidate lessons\n- lesson\n## Candidate follow-ups\n- follow-up" },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            { text: "## What holds up\n- ok\n## Challenges\n- caveat\n## Evidence gaps\n- gap" },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          payloads: [
            { text: "## What holds up\n- ok2\n## Challenges\n- caveat2\n## Evidence gaps\n- gap2" },
          ],
        },
      });

    await runFeishuLearningCouncil({
      cfg: TEST_CFG,
      userMessage: "去学金融领域里最值得内化的部分",
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:dm:ou-user",
      messageId: "msg-learning-finance-missing-anchor",
      workspaceDir,
    });

    const kimiPrompt = String(mockCallGateway.mock.calls[0]?.[0]?.params?.extraSystemPrompt ?? "");
    expect(kimiPrompt).toContain(
      "current research line is missing; keep the study provisional instead of pretending it already matches the current finance doctrine.",
    );
    expect(kimiPrompt).toContain(
      "MEMORY.md is missing; do not narrow this run to one partial subdomain and pretend the full finance operating-system mainline is already loaded.",
    );
    expect(kimiPrompt).toContain("## Local durable memory cards");
    expect(kimiPrompt).toContain(
      "no latest lobster-workface cue was found in this workspace; do not claim prior learning already changed reusable behavior.",
    );
  });
});
