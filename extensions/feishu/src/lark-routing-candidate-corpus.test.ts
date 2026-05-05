import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildLarkPendingRoutingCandidateCorpus,
  buildLarkRoutingCandidatePromotionReview,
  createLarkPendingRoutingCandidate,
  evaluateLarkRoutingCandidateCorpus,
  evaluateLarkPendingRoutingCandidate,
  evaluateLarkPendingRoutingCandidates,
  readLarkRoutingCandidatePromotionArtifacts,
  writeLarkLanguageRoutingCandidateCapture,
} from "./lark-routing-candidate-corpus.js";
import type { FeishuConfig } from "./types.js";

const cfg = {
  surfaces: {
    control_room: { chatId: "oc-control" },
    technical_daily: { chatId: "oc-tech" },
    fundamental_research: { chatId: "oc-fund" },
    knowledge_maintenance: { chatId: "oc-knowledge" },
    ops_audit: { chatId: "oc-ops" },
    learning_command: { chatId: "oc-learning" },
    watchtower: { chatId: "oc-watch" },
  },
} as FeishuConfig;

describe("lark routing candidate corpus", () => {
  it("normalizes API replies into pending language-routing candidates", () => {
    const candidate = createLarkPendingRoutingCandidate({
      source: "api_reply",
      payload: "去学习世界顶级大学前沿金融论文",
      createdAt: "2026-04-27T00:00:00.000Z",
    });

    expect(candidate).toMatchObject({
      id: expect.stringMatching(/^pending-language-api_reply-[a-f0-9]{16}$/u),
      source: "api_reply",
      status: "pending_review",
      boundary: "language_routing_only",
      createdAt: "2026-04-27T00:00:00.000Z",
      utterance: "去学习世界顶级大学前沿金融论文",
      sample: expect.objectContaining({
        disposition: "candidate_semantic_family",
      }),
      semantic: expect.objectContaining({
        family: "external_source_coverage_honesty",
      }),
    });
  });

  it("accepts a pending language candidate only after routing eval passes", () => {
    const candidate = createLarkPendingRoutingCandidate({
      source: "lark_visible_reply",
      payload: "去学习世界顶级大学前沿金融论文",
      createdAt: "2026-04-27T00:00:00.000Z",
    });
    const evaluation = evaluateLarkPendingRoutingCandidate({ cfg, candidate });

    expect(evaluation).toMatchObject({
      reason: "accepted_language_case",
      candidate: expect.objectContaining({
        status: "accepted_language_case",
        boundary: "language_routing_only",
      }),
      acceptedCase: expect.objectContaining({
        id: candidate.id,
        utterance: "去学习世界顶级大学前沿金融论文",
        family: "external_source_coverage_honesty",
        expectedSurface: "learning_command",
        expectedGuardMatchers: ["sourceCoverage"],
        notes: "Auto-normalized language-routing candidate; not a finance learning artifact.",
      }),
      score: expect.objectContaining({
        total: 1,
        deterministicPassed: 1,
        semanticCandidatePassed: 1,
      }),
    });
    expect(JSON.stringify(evaluation)).not.toMatch(
      /finance_learning|finance-learning|memory\/local-memory|capability card/u,
    );
  });

  it("keeps WeChat public-account source learning on the finance pipeline, not language corpus", () => {
    const candidate = createLarkPendingRoutingCandidate({
      source: "api_reply",
      payload:
        "微信公众号文章 sourceType=wechat_public_account_source 应该进入 finance_article_extract_capability_input，而不是 routing corpus。",
    });
    const evaluation = evaluateLarkPendingRoutingCandidate({ cfg, candidate });

    expect(evaluation.reason).not.toBe("accepted_language_case");
    expect(evaluation.acceptedCase).toBeUndefined();
    expect(candidate.boundary).toBe("language_routing_only");
  });

  it("accepts broad options knowledge learning as finance capability intake", () => {
    const candidate = createLarkPendingRoutingCandidate({
      source: "lark_user_utterance",
      payload: "去学期权全知识",
      createdAt: "2026-05-04T00:00:00.000Z",
    });
    const evaluation = evaluateLarkPendingRoutingCandidate({ cfg, candidate });

    expect(evaluation).toMatchObject({
      reason: "accepted_language_case",
      candidate: expect.objectContaining({
        semantic: expect.objectContaining({
          family: "market_capability_learning_intake",
        }),
      }),
      acceptedCase: expect.objectContaining({
        family: "market_capability_learning_intake",
        expectedSurface: "learning_command",
      }),
    });
  });

  it("accepts investment philosophy skill-internalization utterances as external learning", () => {
    const candidate = createLarkPendingRoutingCandidate({
      source: "lark_user_utterance",
      payload: "去将大师的投资理念浓缩成skills，学习进你自己脑子",
      createdAt: "2026-05-04T00:00:00.000Z",
    });
    const evaluation = evaluateLarkPendingRoutingCandidate({ cfg, candidate });

    expect(evaluation).toMatchObject({
      reason: "accepted_language_case",
      candidate: expect.objectContaining({
        semantic: expect.objectContaining({
          family: "learning_external_source",
        }),
      }),
      acceptedCase: expect.objectContaining({
        family: "learning_external_source",
        expectedSurface: "learning_command",
      }),
    });
  });

  it("discards secrets and binary payloads before pending corpus review", () => {
    const secret = createLarkPendingRoutingCandidate({
      source: "api_reply",
      payload: "Authorization: Bearer sk-ant-api03-thisshouldnotbelearned",
    });
    const binary = createLarkPendingRoutingCandidate({
      source: "api_reply",
      payload: Buffer.from([0, 1, 2, 3]),
    });

    expect(evaluateLarkPendingRoutingCandidates({ cfg, candidates: [secret, binary] })).toEqual([
      expect.objectContaining({ reason: "discarded_by_distillation" }),
      expect.objectContaining({ reason: "discarded_by_distillation" }),
    ]);
    expect(secret.utterance).toBeUndefined();
    expect(binary.utterance).toBeUndefined();
  });

  it("batch-builds a pending language corpus and evaluates accepted cases without touching brain artifacts", () => {
    const corpus = buildLarkPendingRoutingCandidateCorpus({
      source: "api_reply",
      generatedAt: "2026-04-27T00:00:00.000Z",
      payloads: [
        "去学习世界顶级大学前沿金融论文",
        "Authorization: Bearer sk-ant-api03-thisshouldnotbelearned",
        "这是一句没有足够路由信号的普通闲聊",
      ],
    });
    const evaluation = evaluateLarkRoutingCandidateCorpus({
      cfg,
      corpus,
      evaluatedAt: "2026-04-27T00:01:00.000Z",
    });

    expect(corpus).toMatchObject({
      schemaVersion: 1,
      boundary: "language_routing_only",
      generatedAt: "2026-04-27T00:00:00.000Z",
      candidates: expect.arrayContaining([
        expect.objectContaining({ status: "pending_review" }),
        expect.objectContaining({ status: "discarded" }),
      ]),
    });
    expect(evaluation).toMatchObject({
      schemaVersion: 1,
      boundary: "language_routing_only",
      evaluatedAt: "2026-04-27T00:01:00.000Z",
      counts: {
        total: 3,
        accepted: 1,
        rejected: 1,
        discarded: 1,
      },
      acceptedCases: [
        expect.objectContaining({
          family: "external_source_coverage_honesty",
          expectedSurface: "learning_command",
        }),
      ],
    });
    expect(JSON.stringify({ corpus, evaluation })).not.toMatch(
      /finance_learning|finance-learning|memory\/local-memory|capability card/u,
    );
  });

  it("uses API route JSON as a label for the paired user utterance without promoting the JSON itself", () => {
    const corpus = buildLarkPendingRoutingCandidateCorpus({
      source: "api_reply",
      generatedAt: "2026-05-03T00:00:00.000Z",
      payloads: [
        {
          family: "learning_external_source",
          confidence: 0.95,
          rationale: "The user asks to learn from an arXiv paper.",
        },
      ],
    });
    const userCandidate = createLarkPendingRoutingCandidate({
      source: "lark_user_utterance",
      payload: "给我学arxiv上一篇论文，你认为值得学的",
      createdAt: "2026-05-03T00:00:00.000Z",
    });
    const evaluation = evaluateLarkRoutingCandidateCorpus({
      cfg,
      corpus: {
        ...corpus,
        candidates: [...corpus.candidates, userCandidate],
      },
      evaluatedAt: "2026-05-03T00:01:00.000Z",
    });

    expect(evaluation.evaluations).toEqual([
      expect.objectContaining({
        reason: "api_route_label_reference",
        candidate: expect.objectContaining({
          source: "api_reply",
          status: "discarded",
          semantic: expect.objectContaining({
            family: "learning_external_source",
          }),
        }),
      }),
      expect.objectContaining({
        reason: "accepted_language_case",
        acceptedCase: expect.objectContaining({
          utterance: "给我学arxiv上一篇论文，你认为值得学的",
          family: "learning_external_source",
          expectedSurface: "learning_command",
        }),
      }),
    ]);
    expect(evaluation.acceptedCases).toHaveLength(1);
    expect(evaluation.acceptedCases[0]?.utterance).toBe("给我学arxiv上一篇论文，你认为值得学的");
    expect(evaluation.acceptedCases[0]?.utterance).not.toContain('"family"');
    expect(evaluation.counts).toEqual({
      total: 2,
      accepted: 1,
      rejected: 0,
      discarded: 1,
    });
  });

  it("discards API-labeled user text when local replay cannot route it deterministically", () => {
    const apiCandidate = createLarkPendingRoutingCandidate({
      source: "api_reply",
      payload: {
        family: "market_capability_learning_intake",
        confidence: 0.82,
        rationale: "options learning should become a reusable capability",
        workOrder: {
          objective: "learn options knowledge and make it application-ready",
          requiredModules: [
            "finance_learning_pipeline_orchestrator",
            "finance_article_extract_capability_input",
          ],
          backendTool: "finance_learning_pipeline_orchestrator",
        },
      },
      createdAt: "2026-05-04T00:00:00.000Z",
    });
    const userCandidate = createLarkPendingRoutingCandidate({
      source: "lark_user_utterance",
      payload: "继续学习期权知识并学会应用",
      createdAt: "2026-05-04T00:00:01.000Z",
    });
    const evaluation = evaluateLarkRoutingCandidateCorpus({
      cfg,
      corpus: {
        schemaVersion: 1,
        boundary: "language_routing_only",
        generatedAt: "2026-05-04T00:00:00.000Z",
        candidates: [apiCandidate, userCandidate],
      },
      evaluatedAt: "2026-05-04T00:01:00.000Z",
    });

    expect(evaluation.evaluations).toEqual([
      expect.objectContaining({ reason: "api_route_label_reference" }),
      expect.objectContaining({
        reason: "api_route_label_reference",
        candidate: expect.objectContaining({
          status: "discarded",
          discardReason: "api_planner_live_handoff_label_only",
        }),
        acceptedCase: expect.objectContaining({
          utterance: "继续学习期权知识并学会应用",
          family: "market_capability_learning_intake",
          expectedSurface: "learning_command",
        }),
      }),
    ]);
    expect(evaluation.counts).toEqual({
      total: 2,
      accepted: 0,
      rejected: 0,
      discarded: 2,
    });
  });

  it("does not leak one API route label across later user utterances", () => {
    const apiCandidate = createLarkPendingRoutingCandidate({
      source: "api_reply",
      payload: {
        family: "learning_external_source",
        confidence: 0.95,
        rationale: "The user asks to learn from an arXiv paper.",
      },
      createdAt: "2026-05-03T00:00:00.000Z",
    });
    const pairedUserCandidate = createLarkPendingRoutingCandidate({
      source: "lark_user_utterance",
      payload: "给我学arxiv上一篇论文，你认为值得学的",
      createdAt: "2026-05-03T00:00:01.000Z",
    });
    const laterUserCandidate = createLarkPendingRoutingCandidate({
      source: "lark_user_utterance",
      payload: "我刚才发的那句现在有没有真的学到，receipt在哪里？",
      createdAt: "2026-05-03T00:00:02.000Z",
    });

    const evaluation = evaluateLarkRoutingCandidateCorpus({
      cfg,
      corpus: {
        schemaVersion: 1,
        boundary: "language_routing_only",
        generatedAt: "2026-05-03T00:00:00.000Z",
        candidates: [apiCandidate, pairedUserCandidate, laterUserCandidate],
      },
      evaluatedAt: "2026-05-03T00:01:00.000Z",
    });

    expect(evaluation.evaluations[1]).toEqual(
      expect.objectContaining({
        reason: "accepted_language_case",
        acceptedCase: expect.objectContaining({
          family: "learning_external_source",
        }),
      }),
    );
    expect(evaluation.evaluations[2]).not.toEqual(
      expect.objectContaining({
        acceptedCase: expect.objectContaining({
          family: "learning_external_source",
        }),
      }),
    );
  });

  it("replays old API route JSON samples even when stored semantic was unknown", () => {
    const apiCandidate = createLarkPendingRoutingCandidate({
      source: "api_reply",
      payload: {
        family: "learning_external_source",
        confidence: 0.95,
        rationale: "The user asks to learn from an arXiv paper.",
      },
      createdAt: "2026-05-03T00:00:00.000Z",
    });
    const userCandidate = createLarkPendingRoutingCandidate({
      source: "lark_user_utterance",
      payload: "给我学arxiv上一篇论文，你认为值得学的",
      createdAt: "2026-05-03T00:00:00.000Z",
    });

    const evaluation = evaluateLarkRoutingCandidateCorpus({
      cfg,
      corpus: {
        schemaVersion: 1,
        boundary: "language_routing_only",
        generatedAt: "2026-05-03T00:00:00.000Z",
        candidates: [
          {
            ...apiCandidate,
            semantic: { family: "unknown", score: 0.1 },
          },
          {
            ...userCandidate,
            semantic: { family: "unknown", score: 0.1 },
          },
        ],
      },
      evaluatedAt: "2026-05-03T00:01:00.000Z",
    });

    expect(evaluation.evaluations[0]).toEqual(
      expect.objectContaining({
        reason: "api_route_label_reference",
        candidate: expect.objectContaining({
          semantic: expect.objectContaining({ family: "learning_external_source" }),
        }),
      }),
    );
    expect(evaluation.evaluations[1]).toEqual(
      expect.objectContaining({
        reason: "accepted_language_case",
        acceptedCase: expect.objectContaining({
          utterance: "给我学arxiv上一篇论文，你认为值得学的",
          family: "learning_external_source",
        }),
      }),
    );
    expect(evaluation.counts).toEqual({
      total: 2,
      accepted: 1,
      rejected: 0,
      discarded: 1,
    });
  });

  it("keeps high-confidence user semantics ahead of a wrong API label hint", () => {
    const apiCandidate = createLarkPendingRoutingCandidate({
      source: "api_reply",
      payload: {
        family: "live_probe_failure",
        confidence: 0.91,
        rationale: "wrongly treated a finance pipeline execution as a live probe",
      },
      createdAt: "2026-05-03T00:00:00.000Z",
    });
    const userCandidate = createLarkPendingRoutingCandidate({
      source: "lark_user_utterance",
      payload:
        "live valid source check source test/fixtures/finance-learning-pipeline/valid-finance-article.md run financelearningpipelineorchestrator learningIntent ETF event triage workflow. Must show learningInternalizationStatus applicationready or failedReason usable answer contract usable answer lines. code lark-live-valid-source-20260502-1",
      createdAt: "2026-05-03T00:00:01.000Z",
    });

    const evaluation = evaluateLarkPendingRoutingCandidates({
      cfg,
      candidates: [apiCandidate, userCandidate],
    });

    expect(evaluation).toEqual([
      expect.objectContaining({ reason: "api_route_label_reference" }),
      expect.objectContaining({
        reason: "accepted_language_case",
        acceptedCase: expect.objectContaining({
          family: "market_capability_learning_intake",
          expectedSurface: "learning_command",
        }),
      }),
    ]);
  });

  it("does not expose deterministic route failures as accepted promotion cases", () => {
    const corpus = buildLarkPendingRoutingCandidateCorpus({
      source: "api_reply",
      generatedAt: "2026-04-27T00:00:00.000Z",
      payloads: ["去 Google 上学习 ETF 轮动的公开资料"],
    });

    const evaluation = evaluateLarkRoutingCandidateCorpus({
      cfg,
      corpus,
      evaluatedAt: "2026-04-27T00:01:00.000Z",
    });

    expect(evaluation.evaluations[0]).toMatchObject({
      reason: "deterministic_route_failed",
      acceptedCase: expect.objectContaining({
        family: "external_source_coverage_honesty",
      }),
    });
    expect(evaluation).toMatchObject({
      acceptedCases: [],
      counts: {
        total: 1,
        accepted: 0,
        rejected: 1,
        discarded: 0,
      },
    });
  });

  it("keeps control-room position-risk orchestration candidates promotable", () => {
    const evaluation = evaluateLarkPendingRoutingCandidate({
      cfg,
      candidate: createLarkPendingRoutingCandidate({
        source: "lark_user_utterance",
        payload:
          "L5真实金融回路验收：如果我长期持有纳指100 ETF，但担心未来三个月出现“高估值 + 利率反弹 + 流动性变差”的组合风险，请用控制室模式处理这个研究任务。要求：判断任务家族，说明内部会调用ETF regime、technical timing、portfolio risk gates、quant_math、causal_map，本地数学不准瞎算，最后给 application_ready 或 failedReason。",
      }),
    });

    expect(evaluation).toMatchObject({
      reason: "accepted_language_case",
      acceptedCase: expect.objectContaining({
        family: "position_risk_adjustment",
        expectedSurface: "control_room",
      }),
    });
  });

  it("accepts real Lark replay families and discards API provider failure chatter", () => {
    const evaluations = evaluateLarkPendingRoutingCandidates({
      cfg,
      candidates: [
        createLarkPendingRoutingCandidate({
          source: "lark_visible_reply",
          payload:
            "我不能直接“重新来一遍”，因为这句话没有说明要重来哪个任务。为了避免串到旧上下文，我没有继续执行，也没有沿用之前的期权学习线。- failedReason: ambiguous_repeat_without_current_subject",
        }),
        createLarkPendingRoutingCandidate({
          source: "lark_user_utterance",
          payload: "重新来一遍",
        }),
        createLarkPendingRoutingCandidate({
          source: "lark_visible_reply",
          payload:
            "🦐 **模块①：期权基础概念** --- ## 1. 期权是什么？ **期权 = 花钱买一个未来可以按约定价格买卖的权利**。你付出权利金，锁定未来价格，到期可以选择执行或放弃。## 2. 两种基本类型 | 类型 | 通俗解释 | 什么时候赚钱 | Call | 买入权 | 标的上涨 | Put | 卖出权 | 标的下跌 | 后续还包括权利金、到期日、行权价和希腊字母。",
        }),
        createLarkPendingRoutingCandidate({
          source: "lark_visible_reply",
          payload: "live-sync-ok gateway 已指向 lcx-s-openclaw",
        }),
        createLarkPendingRoutingCandidate({
          source: "lark_visible_reply",
          payload:
            "**数据新鲜度：弱** 搜索未能获取到2026年4月纳斯达克最近一个月真实日线，因此不能声称已完成 live technical check。SMA(50) vs SMA(200), RSI。",
        }),
        createLarkPendingRoutingCandidate({
          source: "lark_visible_reply",
          payload:
            "金融能力学习流水线完成：learningInternalizationStatus: application_ready failedReason: none retrievalReceiptPath memory/finance-learning-retrieval-receipts/x.json retrievalReviewPath memory/finance-learning-retrieval-reviews/y.json",
        }),
        createLarkPendingRoutingCandidate({
          source: "lark_user_utterance",
          payload:
            "请学习一篇你认为今天最值得吸收的金融/量化 arXiv 论文，输出：论文名、为什么值得学、可复用规则、风险边界、application_ready 或明确失败原因。验收码 lark-live-learning-20260502-1",
        }),
        createLarkPendingRoutingCandidate({
          source: "api_reply",
          payload: {
            family: "unknown",
            confidence: 0,
            rationale: "api route provider failed: Error: gateway timeout after 35000ms",
          },
        }),
        createLarkPendingRoutingCandidate({
          source: "lark_visible_reply",
          payload:
            "family: learning_external_source source_required: true failedReason: no_url_or_local_source_provided next step: ask for URL boundary: do not pretend learned proof: no source",
        }),
        createLarkPendingRoutingCandidate({
          source: "lark_visible_reply",
          payload:
            "架构检查结果 research-only：company_fundamentals_value 负责估值、毛利率、ROI、AI capex回报；causal_map 负责客户集中度与需求可持续性的因果链；portfolio_risk_gates 只是间接风险门控。没有最新财报和实时估值时必须 failedReason，最后输出 NVDA 基本面检查清单。",
        }),
        createLarkPendingRoutingCandidate({
          source: "lark_visible_reply",
          payload:
            "**任务验收码**: `lark-live-fundamental-risk-20260504-1` **框架核心**: ✅ `company_fundamentals_value` + ✅ `causal_map` 均已写入并验证通过 **研究边界**: research-only，禁止任何买卖建议 NVDA基本面风险研究分5条线扫描。无实时财报和实时估值时，所有结论降级为[I]级方向性参考，拒绝上浮为[F]硬数字。",
        }),
        createLarkPendingRoutingCandidate({
          source: "lark_visible_reply",
          payload:
            "**TLT 平均加仓命题——路由终检。** 上一轮已输出完整工作框架（acceptance code `lark-live-bond-etf-risk-20260504-2`），本轮输入无变化，无新数据，无新修正项，结论无变化。本轮仅补发带新验收码的结构化终件，避免重复冗余。 publish: yes | confidence: medium | foundations: portfolio-sizing-discipline, risk-transmission, behavior-error-correction Distribution: held as draft technical slice.",
        }),
        createLarkPendingRoutingCandidate({
          source: "lark_visible_reply",
          payload:
            "Learning council run: full three-model execution completed. Kimi synthesis Lane receipt: runtime provider=moonshot runtime model=moonshot/kimi-k2.6 验收结果 验收码 `live-council-model-allowlist-1` allowlist ok.",
        }),
        createLarkPendingRoutingCandidate({
          source: "lark_visible_reply",
          payload:
            "**验收码**: `lark-live-fundamental-risk-20260504-2` **Framework Core 检查结果**: `company_fundamentals_value` 激活，`causal_map` 激活。实时数据缺失状态 confirmed，以下触发 failedReason 边界。",
        }),
      ],
    });

    expect(evaluations).toEqual([
      expect.objectContaining({
        reason: "discarded_by_distillation",
        candidate: expect.objectContaining({
          status: "discarded",
          discardReason: "clarification_boundary_visible_reply",
        }),
      }),
      expect.objectContaining({
        reason: "discarded_by_distillation",
        candidate: expect.objectContaining({
          status: "discarded",
          discardReason: "ambiguous_repeat_user_utterance",
        }),
      }),
      expect.objectContaining({
        reason: "discarded_by_distillation",
        candidate: expect.objectContaining({
          status: "discarded",
          discardReason: "domain_answer_visible_reply",
        }),
      }),
      expect.objectContaining({
        reason: "accepted_language_case",
        acceptedCase: expect.objectContaining({ family: "live_probe_failure" }),
      }),
      expect.objectContaining({
        reason: "accepted_language_case",
        acceptedCase: expect.objectContaining({ family: "live_probe_failure" }),
      }),
      expect.objectContaining({
        reason: "api_route_label_reference",
        candidate: expect.objectContaining({
          status: "discarded",
        }),
      }),
      expect.objectContaining({
        reason: "accepted_language_case",
        acceptedCase: expect.objectContaining({ family: "market_capability_learning_intake" }),
      }),
      expect.objectContaining({
        reason: "discarded_by_distillation",
        candidate: expect.objectContaining({
          status: "discarded",
          discardReason: "api_route_provider_failure",
        }),
      }),
      expect.objectContaining({
        reason: "api_route_label_reference",
        candidate: expect.objectContaining({
          status: "discarded",
        }),
      }),
      expect.objectContaining({
        reason: "api_route_label_reference",
        candidate: expect.objectContaining({
          status: "discarded",
        }),
      }),
      expect.objectContaining({
        reason: "api_route_label_reference",
        candidate: expect.objectContaining({
          status: "discarded",
        }),
      }),
      expect.objectContaining({
        reason: "accepted_language_case",
        acceptedCase: expect.objectContaining({ family: "position_risk_adjustment" }),
      }),
      expect.objectContaining({
        reason: "api_route_label_reference",
        candidate: expect.objectContaining({
          status: "discarded",
        }),
      }),
      expect.objectContaining({
        reason: "api_route_label_reference",
        candidate: expect.objectContaining({
          status: "discarded",
        }),
      }),
    ]);
  });

  it("writes a live-shaped candidate capture artifact without mutating the formal corpus", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lark-capture-"));
    const capture = await writeLarkLanguageRoutingCandidateCapture({
      workspaceDir: tempDir,
      cfg,
      agentId: "agent-1",
      targetSurface: "learning_command",
      effectiveSurface: "learning_command",
      chatId: "oc-learning",
      sessionKey: "session-1",
      messageId: "msg/capture 1",
      userMessage: "去学习世界顶级大学前沿金融论文",
      finalReplyText: "我会标清楚 source coverage limits。",
      apiReplyPayloads: [
        "去 arxiv 上找资产配置前沿论文，只保留可复用规则并标注覆盖范围",
        "Authorization: Bearer sk-ant-api03-thisshouldnotbelearned",
        Buffer.from([0, 1, 2, 3]),
      ],
      generatedAt: "2026-04-27T00:00:00.000Z",
    });

    expect(capture).toMatchObject({
      relativePath: "memory/lark-language-routing-candidates/2026-04-27/msg-capture-1.json",
      dateKey: "2026-04-27",
      workspaceDir: tempDir,
      artifact: expect.objectContaining({
        schemaVersion: 1,
        boundary: "language_routing_only",
        source: "feishu_final_reply_capture",
        noFinanceLearningArtifact: true,
        messageId: "msg/capture 1",
      }),
    });
    expect(capture?.artifact.candidates.length).toBe(5);
    expect(capture?.artifact.evaluation.counts.accepted).toBeGreaterThanOrEqual(2);
    expect(capture?.artifact.evaluation.counts.discarded).toBe(2);
    const file = JSON.parse(
      await fs.readFile(path.join(tempDir, capture!.relativePath), "utf-8"),
    ) as { noFinanceLearningArtifact?: boolean; boundary?: string };
    expect(file).toMatchObject({
      boundary: "language_routing_only",
      noFinanceLearningArtifact: true,
    });
    expect(JSON.stringify(file)).not.toMatch(
      /finance_learning|finance-learning|memory\/local-memory|capability card/u,
    );

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("promotes only family batches that meet review thresholds", () => {
    const firstCorpus = buildLarkPendingRoutingCandidateCorpus({
      source: "lark_user_utterance",
      generatedAt: "2026-04-27T00:00:00.000Z",
      payloads: ["去学习世界顶级大学前沿金融论文"],
    });
    const secondCorpus = buildLarkPendingRoutingCandidateCorpus({
      source: "lark_visible_reply",
      generatedAt: "2026-04-27T00:02:00.000Z",
      payloads: ["去 Google 上系统性学习最近 agent 记忆怎么做"],
    });
    const review = buildLarkRoutingCandidatePromotionReview({
      generatedAt: "2026-04-27T00:03:00.000Z",
      minAcceptedPerFamily: 2,
      artifacts: [
        {
          boundary: "language_routing_only",
          source: "feishu_final_reply_capture",
          messageId: "msg-1",
          evaluation: evaluateLarkRoutingCandidateCorpus({
            cfg,
            corpus: firstCorpus,
            evaluatedAt: "2026-04-27T00:01:00.000Z",
          }),
        },
        {
          boundary: "language_routing_only",
          source: "feishu_final_reply_capture",
          messageId: "msg-2",
          evaluation: evaluateLarkRoutingCandidateCorpus({
            cfg,
            corpus: secondCorpus,
            evaluatedAt: "2026-04-27T00:02:30.000Z",
          }),
        },
      ],
    });

    expect(review).toMatchObject({
      schemaVersion: 1,
      boundary: "language_routing_only",
      generatedAt: "2026-04-27T00:03:00.000Z",
      minAcceptedPerFamily: 2,
      counts: {
        sourceArtifacts: 2,
        acceptedCases: 2,
        duplicateCases: 0,
        promotedCases: 2,
      },
      familyDecisions: [
        {
          family: "external_source_coverage_honesty",
          accepted: 2,
          promoted: 2,
          status: "eligible_for_review",
        },
      ],
    });
    expect(review.promotedCases).toHaveLength(2);
    expect(review.promotedCases[0]).toMatchObject({
      id: expect.stringMatching(
        /^promoted-language-external_source_coverage_honesty-[a-f0-9]{12}$/u,
      ),
      family: "external_source_coverage_honesty",
      expectedSurface: "learning_command",
      truthBoundary: "evidence_required",
      notes:
        "Promoted from pending Lark language-routing candidate review; not a finance learning artifact.",
    });
    expect(review.corpusPatch).toContain("append these cases to LARK_ROUTING_CORPUS");
    expect(review.corpusPatch).toContain("external_source_coverage_honesty");
    expect(JSON.stringify(review)).not.toMatch(
      /finance_learning|finance-learning|memory\/local-memory|capability card/u,
    );
  });

  it("keeps duplicate or under-threshold language candidates out of promotion patches", () => {
    const corpus = buildLarkPendingRoutingCandidateCorpus({
      source: "lark_user_utterance",
      generatedAt: "2026-04-27T00:00:00.000Z",
      payloads: ["去学习世界顶级大学前沿金融论文"],
    });
    const evaluation = evaluateLarkRoutingCandidateCorpus({
      cfg,
      corpus,
      evaluatedAt: "2026-04-27T00:01:00.000Z",
    });
    const review = buildLarkRoutingCandidatePromotionReview({
      generatedAt: "2026-04-27T00:02:00.000Z",
      minAcceptedPerFamily: 2,
      existingCorpus: [
        {
          id: "existing-language-case",
          utterance: "去学习世界顶级大学前沿金融论文",
          family: "external_source_coverage_honesty",
          expectedSurface: "learning_command",
          truthBoundary: "evidence_required",
        },
      ],
      artifacts: [
        {
          boundary: "language_routing_only",
          source: "feishu_final_reply_capture",
          messageId: "msg-duplicate",
          evaluation,
        },
      ],
    });

    expect(review).toMatchObject({
      counts: {
        sourceArtifacts: 1,
        acceptedCases: 1,
        duplicateCases: 1,
        promotedCases: 0,
      },
      promotedCases: [],
    });
    expect(review.corpusPatch).toContain("No language-routing candidates met promotion thresholds");
  });

  it("scans pending language artifact files and skips invalid boundaries", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lark-pending-scan-"));
    const rootDir = path.join(tempDir, "memory", "lark-language-routing-candidates");
    const validDir = path.join(rootDir, "2026-04-27");
    await fs.mkdir(validDir, { recursive: true });

    const corpus = buildLarkPendingRoutingCandidateCorpus({
      source: "lark_user_utterance",
      generatedAt: "2026-04-27T00:00:00.000Z",
      payloads: ["去学习世界顶级大学前沿金融论文"],
    });
    await fs.writeFile(
      path.join(validDir, "msg-valid.json"),
      JSON.stringify({
        schemaVersion: 1,
        boundary: "language_routing_only",
        source: "feishu_final_reply_capture",
        messageId: "msg-valid",
        noFinanceLearningArtifact: true,
        evaluation: evaluateLarkRoutingCandidateCorpus({
          cfg,
          corpus,
          evaluatedAt: "2026-04-27T00:01:00.000Z",
        }),
      }),
      "utf-8",
    );
    await fs.writeFile(path.join(validDir, "broken.json"), "{", "utf-8");
    await fs.writeFile(
      path.join(validDir, "finance.json"),
      JSON.stringify({
        boundary: "finance_learning",
        evaluation: { acceptedCases: [] },
      }),
      "utf-8",
    );
    await fs.writeFile(
      path.join(validDir, "language-without-brain-boundary-marker.json"),
      JSON.stringify({
        schemaVersion: 1,
        boundary: "language_routing_only",
        source: "feishu_final_reply_capture",
        messageId: "msg-unmarked",
        evaluation: evaluateLarkRoutingCandidateCorpus({
          cfg,
          corpus,
          evaluatedAt: "2026-04-27T00:01:00.000Z",
        }),
      }),
      "utf-8",
    );

    const result = await readLarkRoutingCandidatePromotionArtifacts({ rootDir });

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({
      boundary: "language_routing_only",
      noFinanceLearningArtifact: true,
      messageId: "msg-valid",
    });
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "parse_failed" }),
        expect.objectContaining({ reason: "invalid_language_boundary" }),
        expect.objectContaining({ reason: "missing_language_brain_boundary_marker" }),
      ]),
    );

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("treats a missing candidate directory as an empty review queue", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lark-pending-empty-"));
    const result = await readLarkRoutingCandidatePromotionArtifacts({
      rootDir: path.join(tempDir, "memory", "lark-language-routing-candidates", "2026-04-28"),
    });

    expect(result).toEqual({
      artifacts: [],
      skipped: [],
    });

    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
