import { describe, expect, it } from "vitest";
import {
  buildFeishuControlRoomOrchestrationNotice,
  buildFeishuSurfaceNotice,
  parseFeishuClassifiedArtifacts,
  resolveFeishuClassifiedPublishResult,
  resolveFeishuControlRoomOrchestration,
  resolveFeishuSurfaceRouting,
} from "./surfaces.js";
import type { FeishuConfig } from "./types.js";

describe("resolveFeishuSurfaceRouting", () => {
  it("routes macro prompts to technical_daily with explicit target chat mapping", () => {
    const routing = resolveFeishuSurfaceRouting({
      cfg: {
        surfaces: {
          technical_daily: { chatId: "oc-tech" },
        },
      } as FeishuConfig,
      chatId: "oc-random",
      content: "去看看几个指数最新的风险和潜在收益",
    });

    expect(routing.targetSurface).toBe("technical_daily");
    expect(routing.targetChatId).toBe("oc-tech");
    expect(routing.roleContract).toBe("technical analyst");
    expect(routing.source).toBe("intent_route");
  });

  it("routes reset-style control intents to control_room", () => {
    const routing = resolveFeishuSurfaceRouting({
      cfg: {
        surfaces: {
          control_room: { chatId: "oc-control" },
        },
      } as FeishuConfig,
      chatId: "oc-random",
      content: "继续这个研究线",
      normalizedCommandText: "/new 继续这个研究线",
    });

    expect(routing.targetSurface).toBe("control_room");
    expect(routing.targetChatId).toBe("oc-control");
  });

  it("routes explicit research-line continuation asks to control_room", () => {
    const cases = [
      "别换线，沿着上一轮继续下一步",
      "接着刚才那条研究线往下做",
      "这条线先别开新分支，继续收敛",
      "上一轮那个结论接着推进",
    ];

    for (const content of cases) {
      const routing = resolveFeishuSurfaceRouting({
        cfg: {
          surfaces: {
            control_room: { chatId: "oc-control" },
          },
        } as FeishuConfig,
        chatId: "oc-random",
        content,
      });

      expect(routing.targetSurface, content).toBe("control_room");
      expect(routing.targetChatId, content).toBe("oc-control");
    }
  });

  it("does not treat domain-specific continuation as current-line continuation", () => {
    const routing = resolveFeishuSurfaceRouting({
      cfg: {
        surfaces: {
          fundamental_research: { chatId: "oc-fundamental" },
          control_room: { chatId: "oc-control" },
        },
      } as FeishuConfig,
      chatId: "oc-random",
      content: "继续分析一下这家公司的财报差异",
    });

    expect(routing.targetSurface).toBe("fundamental_research");
    expect(routing.targetChatId).toBe("oc-fundamental");
  });

  it("keeps configured chat binding when no stronger intent route exists", () => {
    const routing = resolveFeishuSurfaceRouting({
      cfg: {
        surfaces: {
          fundamental_research: { chatId: "oc-fundamental" },
        },
      } as FeishuConfig,
      chatId: "oc-fundamental",
      content: "今天的跟进先整理一下",
    });

    expect(routing.currentSurface).toBe("fundamental_research");
    expect(routing.targetSurface).toBe("fundamental_research");
    expect(routing.source).toBe("chat_binding");
  });

  it("keeps a specialist chat pinned to its configured lane", () => {
    const routing = resolveFeishuSurfaceRouting({
      cfg: {
        surfaces: {
          fundamental_research: { chatId: "oc-fundamental" },
          technical_daily: { chatId: "oc-tech" },
        },
      } as FeishuConfig,
      chatId: "oc-fundamental",
      content: "去看看几个指数最新的风险和潜在收益",
    });

    expect(routing.currentSurface).toBe("fundamental_research");
    expect(routing.targetSurface).toBe("fundamental_research");
    expect(routing.suppressedIntentSurface).toBe("technical_daily");
    expect(routing.targetChatId).toBe("oc-fundamental");
    expect(routing.source).toBe("chat_binding");
  });

  it("still records a suppressed foreign intent when the current specialist lane is also the first match", () => {
    const routing = resolveFeishuSurfaceRouting({
      cfg: {
        surfaces: {
          fundamental_research: { chatId: "oc-fundamental" },
          technical_daily: { chatId: "oc-tech" },
        },
      } as FeishuConfig,
      chatId: "oc-fundamental",
      content: "读一下科技财报，再看看长端利率和 QQQ 的风险传导",
    });

    expect(routing.currentSurface).toBe("fundamental_research");
    expect(routing.targetSurface).toBe("fundamental_research");
    expect(routing.suppressedIntentSurface).toBe("technical_daily");
    expect(routing.source).toBe("chat_binding");
  });

  it("still lets a control-room chat route out to a specialist lane", () => {
    const routing = resolveFeishuSurfaceRouting({
      cfg: {
        surfaces: {
          control_room: { chatId: "oc-control" },
          technical_daily: { chatId: "oc-tech" },
        },
      } as FeishuConfig,
      chatId: "oc-control",
      content: "去看看几个指数最新的风险和潜在收益",
    });

    expect(routing.currentSurface).toBe("control_room");
    expect(routing.targetSurface).toBe("technical_daily");
    expect(routing.targetChatId).toBe("oc-tech");
    expect(routing.source).toBe("intent_route_with_chat_binding");
  });

  it("does not pretend a duplicated chat binding is a unique current surface", () => {
    const routing = resolveFeishuSurfaceRouting({
      cfg: {
        surfaces: {
          control_room: { chatId: "oc-shared" },
          technical_daily: { chatId: "oc-shared" },
          fundamental_research: { chatId: "oc-shared" },
        },
      } as FeishuConfig,
      chatId: "oc-shared",
      content: "去看看几个指数最新的风险和潜在收益",
    });

    expect(routing.currentSurface).toBeUndefined();
    expect(routing.targetSurface).toBe("technical_daily");
    expect(routing.source).toBe("intent_route");
  });

  it("routes explicit multi-model learning requests to learning_command", () => {
    const routing = resolveFeishuSurfaceRouting({
      cfg: {
        surfaces: {
          learning_command: { chatId: "oc-learning" },
        },
      } as FeishuConfig,
      chatId: "oc-random",
      content: "用三个模型一起学这个主题，给我一个学习委员会结果",
    });

    expect(routing.targetSurface).toBe("learning_command");
    expect(routing.targetChatId).toBe("oc-learning");
    expect(routing.roleContract).toBe("learning council orchestrator");
    expect(routing.source).toBe("intent_route");
  });

  it("routes agent-platform and financial-strategy learning asks to learning_command", () => {
    const routing = resolveFeishuSurfaceRouting({
      cfg: {
        surfaces: {
          learning_command: { chatId: "oc-learning" },
        },
      } as FeishuConfig,
      chatId: "oc-random",
      content: "去学开源的新金融策略和金融技术，再了解新的 agent platform",
    });

    expect(routing.targetSurface).toBe("learning_command");
    expect(routing.targetChatId).toBe("oc-learning");
  });

  it("routes plain-language open-source learning asks to learning_command", () => {
    const routing = resolveFeishuSurfaceRouting({
      cfg: {
        surfaces: {
          learning_command: { chatId: "oc-learning" },
        },
      } as FeishuConfig,
      chatId: "oc-random",
      content: "去学一下最近开源里有什么值得学，学完说人话总结给我",
    });

    expect(routing.targetSurface).toBe("learning_command");
  });

  it("routes GitHub/open-source internalization asks to learning_command", () => {
    const routing = resolveFeishuSurfaceRouting({
      cfg: {
        surfaces: {
          learning_command: { chatId: "oc-learning" },
        },
      } as FeishuConfig,
      chatId: "oc-random",
      content: "去github上学习开源的值得你学的，并把值得内化的内化",
    });

    expect(routing.targetSurface).toBe("learning_command");
    expect(routing.targetChatId).toBe("oc-learning");
  });

  it("routes colloquial GitHub/open-source internalization asks to learning_command", () => {
    const routing = resolveFeishuSurfaceRouting({
      cfg: {
        surfaces: {
          learning_command: { chatId: "oc-learning" },
        },
      } as FeishuConfig,
      chatId: "oc-random",
      content: "去github上学值得你学的，但别做开源综述，直接告诉我哪些会改你以后的做法",
    });

    expect(routing.targetSurface).toBe("learning_command");
    expect(routing.targetChatId).toBe("oc-learning");
  });

  it("routes rough colloquial GitHub skill-stealing asks to learning_command", () => {
    const routing = resolveFeishuSurfaceRouting({
      cfg: {
        surfaces: {
          learning_command: { chatId: "oc-learning" },
        },
      } as FeishuConfig,
      chatId: "oc-random",
      content: "github上那些能偷的招你去偷，最后只说真会改你手法的三条，别做分享会",
    });

    expect(routing.targetSurface).toBe("learning_command");
    expect(routing.targetChatId).toBe("oc-learning");
  });

  it("routes external-source learning ask families to learning_command", () => {
    const cases = [
      "去 Google 上学最近 agent 记忆怎么做，只留下会改你以后做法的三条",
      "网上搜一下最近金融智能体文章，别复述文章，只说哪些值得内化",
      "查一下 arxiv 上 agent workflow 的新文章，筛出以后会复用的规则",
      "去看几篇 blog 和 docs，别做综述，只留下能改你研究流程的东西",
      "去 Google 上学半个小时，学 agent 记忆怎么做",
      "从网上找资料持续学30分钟，主题是 finance agent workflow",
      "看看同类 agent 怎么做长期记忆，筛出能改你工作流的规则",
      "找几个竞品智能体的做法参考一下，别做综述，只留下可复用的",
    ];

    for (const content of cases) {
      const routing = resolveFeishuSurfaceRouting({
        cfg: {
          surfaces: {
            learning_command: { chatId: "oc-learning" },
          },
        } as FeishuConfig,
        chatId: "oc-random",
        content,
      });

      expect(routing.targetSurface, content).toBe("learning_command");
      expect(routing.targetChatId, content).toBe("oc-learning");
    }
  });

  it("routes Hermes install and memory-provider learning asks to learning_command", () => {
    const routing = resolveFeishuSurfaceRouting({
      cfg: {
        surfaces: {
          learning_command: { chatId: "oc-learning" },
        },
      } as FeishuConfig,
      chatId: "oc-random",
      content:
        "去github上看 Hermes-agent 的安装、context files 和 memory providers，学会后接进你自己",
    });

    expect(routing.targetSurface).toBe("learning_command");
    expect(routing.targetChatId).toBe("oc-learning");
  });

  it("routes LLM-finance-agent article learning asks to learning_command", () => {
    const routing = resolveFeishuSurfaceRouting({
      cfg: {
        surfaces: {
          learning_command: { chatId: "oc-learning" },
        },
      } as FeishuConfig,
      chatId: "oc-random",
      content: "去读关于llm应用在金融智能体上的文章，对你自我提升的启发",
    });

    expect(routing.targetSurface).toBe("learning_command");
    expect(routing.targetChatId).toBe("oc-learning");
  });

  it("routes daily-frequency finance learning asks to learning_command", () => {
    const routing = resolveFeishuSurfaceRouting({
      cfg: {
        surfaces: {
          learning_command: { chatId: "oc-learning" },
        },
      } as FeishuConfig,
      chatId: "oc-random",
      content: "学学新的日频技术",
    });

    expect(routing.targetSurface).toBe("learning_command");
    expect(routing.targetChatId).toBe("oc-learning");
  });

  it("routes explicit 'start learning now' asks to learning_command", () => {
    const routing = resolveFeishuSurfaceRouting({
      cfg: {
        surfaces: {
          learning_command: { chatId: "oc-learning" },
          knowledge_maintenance: { chatId: "oc-knowledge" },
        },
      } as FeishuConfig,
      chatId: "oc-random",
      content: "现在开始学习金融主线，后面要帮我做研究和持仓分析",
    });

    expect(routing.targetSurface).toBe("learning_command");
    expect(routing.targetChatId).toBe("oc-learning");
  });

  it("routes explicit technical-slice summary asks to technical_daily", () => {
    const routing = resolveFeishuSurfaceRouting({
      cfg: {
        surfaces: {
          technical_daily: { chatId: "oc-tech" },
        },
      } as FeishuConfig,
      chatId: "oc-random",
      content: "给我一个技术面总览",
    });

    expect(routing.targetSurface).toBe("technical_daily");
    expect(routing.targetChatId).toBe("oc-tech");
  });

  it("routes AI capex research asks to fundamental_research", () => {
    const routing = resolveFeishuSurfaceRouting({
      cfg: {
        surfaces: {
          fundamental_research: { chatId: "oc-fundamental" },
        },
      } as FeishuConfig,
      chatId: "oc-random",
      content: "把 AI capex 这条线给我讲清楚",
    });

    expect(routing.targetSurface).toBe("fundamental_research");
    expect(routing.targetChatId).toBe("oc-fundamental");
  });

  it("routes web-search availability questions to ops_audit", () => {
    const routing = resolveFeishuSurfaceRouting({
      cfg: {
        surfaces: {
          ops_audit: { chatId: "oc-ops" },
        },
      } as FeishuConfig,
      chatId: "oc-random",
      content: "现在网络搜索可以用吗",
    });

    expect(routing.targetSurface).toBe("ops_audit");
    expect(routing.targetChatId).toBe("oc-ops");
  });

  it("routes bilingual comprehension learning asks to learning_command", () => {
    const routing = resolveFeishuSurfaceRouting({
      cfg: {
        surfaces: {
          learning_command: { chatId: "oc-learning" },
        },
      } as FeishuConfig,
      chatId: "oc-random",
      content: "让龙虾学中英双语理解、术语映射和自然语言 workflow 触发词",
    });

    expect(routing.targetSurface).toBe("learning_command");
    expect(routing.targetChatId).toBe("oc-learning");
  });

  it("routes DS/statistics ETF-timing study asks to learning_command instead of technical_daily", () => {
    const routing = resolveFeishuSurfaceRouting({
      cfg: {
        surfaces: {
          learning_command: { chatId: "oc-learning" },
          technical_daily: { chatId: "oc-tech" },
        },
      } as FeishuConfig,
      chatId: "oc-random",
      content:
        "我是学ds统计的中国散户，想把回归、样本外验证、bootstrap 和显著性检验用到 ETF 择时上，你去学一下最值得我反复记住的框架",
    });

    expect(routing.targetSurface).toBe("learning_command");
    expect(routing.targetChatId).toBe("oc-learning");
  });

  it("routes DS/statistics ETF-timing method questions to learning_command instead of technical_daily", () => {
    const routing = resolveFeishuSurfaceRouting({
      cfg: {
        surfaces: {
          learning_command: { chatId: "oc-learning" },
          technical_daily: { chatId: "oc-tech" },
        },
      } as FeishuConfig,
      chatId: "oc-random",
      content:
        "我是学ds和统计的中国散户，你别给我讲市场大词，直接告诉我：如果我做ETF轮动，用样本外、walk-forward、bootstrap，什么结果才算没有自欺欺人？",
    });

    expect(routing.targetSurface).toBe("learning_command");
    expect(routing.targetChatId).toBe("oc-learning");
  });

  it("routes correction-prefixed feedback to knowledge_maintenance", () => {
    const routing = resolveFeishuSurfaceRouting({
      cfg: {
        surfaces: {
          knowledge_maintenance: { chatId: "oc-knowledge" },
        },
      } as FeishuConfig,
      chatId: "oc-random",
      content: "反馈：你昨天那条 QQQ 风险判断太满了，证据不够。",
    });

    expect(routing.targetSurface).toBe("knowledge_maintenance");
    expect(routing.targetChatId).toBe("oc-knowledge");
  });

  it("routes correction carryover asks to knowledge_maintenance", () => {
    const cases = [
      "刚才那句回答太满了，下次别把没证据的东西说死",
      "这条规则记住，以后遇到 provider 没确认就别说已经接上",
      "你刚才把 session 理解说成长期记忆了，改掉这个习惯",
    ];

    for (const content of cases) {
      const routing = resolveFeishuSurfaceRouting({
        cfg: {
          surfaces: {
            knowledge_maintenance: { chatId: "oc-knowledge" },
          },
        } as FeishuConfig,
        chatId: "oc-random",
        content,
      });

      expect(routing.targetSurface, content).toBe("knowledge_maintenance");
      expect(routing.targetChatId, content).toBe("oc-knowledge");
    }
  });

  it("routes source-grounding challenges to ops_audit", () => {
    const cases = [
      "你这句话哪来的，给我出处",
      "刚才那个结论有来源吗",
      "这条判断是你确认过的还是猜的",
      "没源没证据就说不知道，别编",
    ];

    for (const content of cases) {
      const routing = resolveFeishuSurfaceRouting({
        cfg: {
          surfaces: {
            ops_audit: { chatId: "oc-ops" },
          },
        } as FeishuConfig,
        chatId: "oc-random",
        content,
      });

      expect(routing.targetSurface, content).toBe("ops_audit");
      expect(routing.targetChatId, content).toBe("oc-ops");
    }
  });

  it("routes explicit repair-ticket and anomaly asks to watchtower", () => {
    const routing = resolveFeishuSurfaceRouting({
      cfg: {
        surfaces: {
          watchtower: { chatId: "oc-watchtower" },
        },
      } as FeishuConfig,
      chatId: "oc-random",
      content: "生成一张 repair ticket，汇总最近的 anomaly 和 hallucination spike",
    });

    expect(routing.targetSurface).toBe("watchtower");
    expect(routing.targetChatId).toBe("oc-watchtower");
    expect(routing.roleContract).toBe("repair sentinel");
  });
});

describe("buildFeishuSurfaceNotice", () => {
  it("renders the target surface, role contract, and configured target chat", () => {
    const notice = buildFeishuSurfaceNotice({
      currentSurface: "fundamental_research",
      targetSurface: "technical_daily",
      targetChatId: "oc-tech",
      roleContract: "technical analyst",
      source: "intent_route_with_chat_binding",
    });

    expect(notice).toContain("Feishu operating surface target = technical_daily");
    expect(notice).toContain("Surface role contract = technical analyst");
    expect(notice).toContain("This is a dedicated technical_daily working lane");
    expect(notice).toContain("answer only the part that belongs to technical_daily");
    expect(notice).toContain(
      "terse continuation or approval turns such as 继续, 下一步, 按优先级学, 扎实补好, 好的, ok, or continue usually mean keep the current lane",
    );
    expect(notice).toContain(
      "Before acting, classify the operator's work intent from the current message: direct answer, bounded continuation, learning or research, correction or review, search or health check, or explicit implementation.",
    );
    expect(notice).toContain(
      "If the work intent is ambiguous, default to the smallest useful mode that keeps progress visible",
    );
    expect(notice).toContain(
      "Feishu status boundary: before claiming live-fixed, dev-fixed, started, running, completed, blocked, or unproven",
    );
    expect(notice).toContain(
      "Treat questions like 现在在干什么, 修到哪了, 还剩多少, 是不是 live 了, 现在能用了吗, and what remains as status-readback requests.",
    );
    expect(notice).toContain(
      "Answer them from evidence order first, not from narrative memory or optimistic progress prose.",
    );
    expect(notice).toContain("use current evidence instead of chat memory alone");
    expect(notice).toContain("dev-fixed means local implementation or tests");
    expect(notice).toContain(
      "live-fixed means migrated, built, restarted, probed, and verified through the real Lark/Feishu path",
    );
    expect(notice).toContain("say unproven or unknown and name the next check");
    expect(notice).toContain("Configured target chat for this surface = oc-tech");
    expect(notice).toContain("arrived via configured surface fundamental_research");
  });

  it("renders a lane-pinning warning when a foreign specialist intent is suppressed", () => {
    const notice = buildFeishuSurfaceNotice({
      currentSurface: "fundamental_research",
      targetSurface: "fundamental_research",
      suppressedIntentSurface: "technical_daily",
      targetChatId: "oc-fundamental",
      roleContract: "fundamental researcher",
      source: "chat_binding",
    });

    expect(notice).toContain("This specialist lane is pinned to fundamental_research");
    expect(notice).toContain("alternate intent was intentionally suppressed");
    expect(notice).toContain("do not switch workflows inside this chat");
  });

  it("renders the self-build boundary for control_room", () => {
    const notice = buildFeishuSurfaceNotice({
      targetSurface: "control_room",
      targetChatId: "oc-control",
      roleContract: "orchestrator",
      source: "intent_route",
    });

    expect(notice).toContain("Feishu operating surface target = control_room");
    expect(notice).toContain(
      "Feishu status boundary: before claiming live-fixed, dev-fixed, started, running, completed, blocked, or unproven",
    );
    expect(notice).toContain(
      "you may directly create or update low-risk artifacts such as HOOK notes, correction notes, weekly reviews, learning summaries",
    );
    expect(notice).toContain(
      "Do not directly rewrite high-risk core layers such as provider-routing main paths, hard risk gates, shared-summary protection",
    );
    expect(notice).toContain("default to proposal or ticket, not direct self-modification");
    expect(notice).toContain(
      "If artifact persistence fails, say it is understood for the current session but not yet in long-term storage",
    );
    expect(notice).toContain(
      "Do not silently escalate those turns into long code generation, file creation, or workspace-write workflows unless the operator explicitly asks to implement, write, save, create a file, or patch something.",
    );
  });

  it("renders the learning council contract and safety boundary for learning_command", () => {
    const notice = buildFeishuSurfaceNotice({
      targetSurface: "learning_command",
      targetChatId: "oc-learning",
      roleContract: "learning council orchestrator",
      source: "intent_route",
    });

    expect(notice).toContain("Feishu operating surface target = learning_command");
    expect(notice).toContain("Surface role contract = learning council orchestrator");
    expect(notice).toContain("use current evidence instead of chat memory alone");
    expect(notice).toContain("Speak human-first. Start with 2-4 plain-language bullets");
    expect(notice).toContain("Learning council mode is active");
    expect(notice).toContain("Kimi = synthesis lane");
    expect(notice).toContain("MiniMax = challenge / counter-argument / weakness-detection lane");
    expect(notice).toContain("DeepSeek = extraction / lesson-transfer lane");
    expect(notice).toContain(
      "Treat Kimi / MiniMax / DeepSeek as stable council lane labels, not as proof of which provider actually ran.",
    );
    expect(notice).toContain(
      "you may directly create or update low-risk artifacts such as HOOK notes, correction notes, weekly reviews, learning summaries",
    );
    expect(notice).toContain("Do not fake a council by writing one blended answer");
    expect(notice).toContain(
      "Use exactly these five sections in order: 1. Kimi synthesis, 2. MiniMax challenge, 3. DeepSeek extraction, 4. Council consensus, 5. Follow-up checklist.",
    );
    expect(notice).toContain(
      "Treat that five-part structure as a required output schema, not a style suggestion.",
    );
    expect(notice).toContain(
      "Do not write 模型一 / 模型二 / 模型三, model one / two / three, or replace the three named model roles with generic analytical frames",
    );
    expect(notice).toContain(
      "If runtime receipts are present, keep the lane semantics but do not let an outdated vendor assumption overwrite the actual provider/model.",
    );
    expect(notice).toContain(
      "Council consensus must explicitly separate: agreed points, disagreement, evidence that is still weak, and what cannot yet be concluded.",
    );
    expect(notice).toContain(
      "Council consensus must contain these explicit subfields: agreements, disagreements, and evidence gaps.",
    );
    expect(notice).toContain(
      "If this turn does not actually contain separately attributable Kimi, MiniMax, and DeepSeek role outputs, do not pretend it does.",
    );
    expect(notice).toContain("mark numbers as provisional / low-fidelity / prior, or omit them");
    expect(notice).toContain(
      "Prohibited in learning-council output unless the user explicitly asks: model one / two / three framing, direct trading advice, point targets, support/resistance calls",
    );
    expect(notice).toContain(
      "Before finalizing, self-audit the output: verify the five required sections exist",
    );
    expect(notice).toContain(
      "prefer compact reusable outputs around seven foundations: portfolio sizing discipline, risk transmission, outcome review, behavior-error correction, low-frequency execution hygiene, business quality, and catalyst mapping",
    );
    expect(notice).toContain(
      "Do not optimize for becoming a generic super-agent. Stable finance-domain usefulness comes first",
    );
    expect(notice).toContain(
      "If a learning request is mostly about agent tooling, platform design, or open-source patterns, keep it bounded",
    );
    expect(notice).toContain(
      "For external-source learning requests such as Google/web search, arXiv/papers, blogs/docs, GitHub/repos, peer agents, competitor systems, or benchmark examples, do not produce a source tour.",
    );
    expect(notice).toContain(
      "Convert source material into bounded adoption knowledge: retain, discard, replay trigger, next eval, compatibility risk, and one verifiable next step for Lobster.",
    );
    expect(notice).toContain(
      "For another-agent, GitHub CLI, install/setup/migration, context-file, skills/plugin, or memory-provider topic, distill it as bounded adoption knowledge",
    );
    expect(notice).toContain("bilingual Chinese/English comprehension for Lobster itself");
    expect(notice).toContain(
      "If the user says 日频技术 or 日频策略 without extra qualifiers, interpret it as finance or quant methods for daily-frequency research by default",
    );
    expect(notice).toContain("If search, browsing, or source coverage looks weak for one role");
    expect(notice).toContain("learning outputs are not direct execution decisions");
    expect(notice).toContain(
      "If the user requests a timeboxed or duration-bound learning session such as 学一个小时 or 持续学习 30 分钟, do not pretend a persistent background study session started unless this path actually has one.",
    );
    expect(notice).toContain("Configured target chat for this surface = oc-learning");
  });

  it("renders a bounded anomaly-reporting contract for watchtower", () => {
    const notice = buildFeishuSurfaceNotice({
      targetSurface: "watchtower",
      targetChatId: "oc-watchtower",
      roleContract: "repair sentinel",
      source: "intent_route",
    });

    expect(notice).toContain("Feishu operating surface target = watchtower");
    expect(notice).toContain("Surface role contract = repair sentinel");
    expect(notice).toContain("Watchtower mode is active");
    expect(notice).toContain("Be short, hard, and executable");
    expect(notice).toContain("Report only meaningful anomalies");
    expect(notice).toContain("Do not spam polish issues");
    expect(notice).toContain(
      "Prefer structured repair-ticket candidates with these fields when evidence is sufficient",
    );
    expect(notice).toContain("Category, Foundation Template, Problem, Evidence, Impact");
    expect(notice).toContain(
      "Do not propose broad refactors, new providers, new memory architecture",
    );
    expect(notice).toContain(
      "Severity, Category, Foundation Template, Problem, Evidence, Impact, Operator action",
    );
    expect(notice).toContain(
      "Use exact field labels when possible: Alert, Severity, Category, Foundation Template, Problem, Evidence, Impact, Operator action",
    );
    expect(notice).toContain(
      "If evidence is weak or the issue is just polish, mark it as observe_only",
    );
    expect(notice).toContain("Operator action must be a bounded next step");
    expect(notice).toContain(
      "Do not let watchtower replies turn into essays, market commentary, or support-bot apologies",
    );
    expect(notice).toContain("must not directly rewrite doctrine, memory, or execution behavior");
    expect(notice).toContain("Configured target chat for this surface = oc-watchtower");
  });

  it("renders source-grounding discipline for ops_audit", () => {
    const notice = buildFeishuSurfaceNotice({
      targetSurface: "ops_audit",
      targetChatId: "oc-ops",
      roleContract: "ops auditor",
      source: "intent_route",
    });

    expect(notice).toContain(
      "For source-grounding or evidence challenges, separate verified evidence, missing evidence, and inferred claims.",
    );
    expect(notice).toContain("say unknown or unverified instead of filling the gap");
  });

  it("renders human-first summary guidance for knowledge_maintenance", () => {
    const notice = buildFeishuSurfaceNotice({
      targetSurface: "knowledge_maintenance",
      targetChatId: "oc-knowledge",
      roleContract: "knowledge maintainer",
      source: "intent_route",
    });

    expect(notice).toContain(
      "When summarizing learning, correction, or review work, speak in plain language first",
    );
  });
});

describe("resolveFeishuControlRoomOrchestration", () => {
  it("fans out broad control-room asks to the main specialist surfaces", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "control_room",
      content: "今天该关注什么，给我一个总览",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: [
        "technical_daily",
        "fundamental_research",
        "knowledge_maintenance",
        "ops_audit",
      ],
      publishMode: "classified_publish",
      replyContract: "default",
      includeDailyWorkface: true,
    });
  });

  it("fans out daily health or excellence reports to market, fundamental, learning, and ops", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "control_room",
      content: "给我一个今天的健康卓越日报",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: [
        "technical_daily",
        "fundamental_research",
        "knowledge_maintenance",
        "ops_audit",
      ],
      publishMode: "classified_publish",
      replyContract: "default",
      includeDailyWorkface: true,
    });
  });

  it("keeps control-room red-team summaries aggregate even when the wording contains correction cues", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "knowledge_maintenance",
      content: "今天的控制室总结，如果错了最可能错在哪",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: [
        "technical_daily",
        "fundamental_research",
        "knowledge_maintenance",
        "ops_audit",
      ],
      publishMode: "classified_publish",
      replyContract: "default",
      includeDailyWorkface: true,
    });
  });

  it("treats cross-loop total-overview asks as aggregate control-room work instead of a single lane", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "knowledge_maintenance",
      content: "给我一个今天的研究/学习/风控总览",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: [
        "technical_daily",
        "fundamental_research",
        "knowledge_maintenance",
        "ops_audit",
      ],
      publishMode: "classified_publish",
      replyContract: "default",
      includeDailyWorkface: true,
    });
  });

  it("treats combined system-health and learning-state asks as aggregate control-room summaries", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "ops_audit",
      content: "把今天的系统健康、学习状态、研究状态一起讲给我",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: [
        "technical_daily",
        "fundamental_research",
        "knowledge_maintenance",
        "ops_audit",
      ],
      publishMode: "classified_publish",
      replyContract: "default",
      includeDailyWorkface: true,
    });
  });

  it("keeps skepticism-heavy control-room risk asks from dropping empty", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "control_room",
      content: "哪里最值得怀疑",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: [
        "technical_daily",
        "fundamental_research",
        "knowledge_maintenance",
        "ops_audit",
      ],
      publishMode: "classified_publish",
      replyContract: "default",
      includeDailyWorkface: true,
    });
  });

  it("keeps seven-day stability asks on the aggregate control-room path", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "control_room",
      content: "最近七天哪条自动化最不稳定",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: [
        "technical_daily",
        "fundamental_research",
        "knowledge_maintenance",
        "ops_audit",
      ],
      publishMode: "classified_publish",
      replyContract: "default",
      includeDailyWorkface: true,
    });
  });

  it("treats plain-language workface asks as daily operating briefs", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "control_room",
      content: "昨天学了什么，昨天纠正了什么，给我一个工作面板",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: [
        "technical_daily",
        "fundamental_research",
        "knowledge_maintenance",
        "ops_audit",
      ],
      publishMode: "classified_publish",
      replyContract: "default",
      includeDailyWorkface: true,
    });
  });

  it("fans out specialist asks from control room without requiring manual group switching", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "technical_daily",
      content: "去看看几个指数最新的风险和潜在收益",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["technical_daily"],
      publishMode: "classified_publish",
      replyContract: "default",
    });
  });

  it("supports expand follow-ups in the control room", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "control_room",
      content: "expand technical",
    });

    expect(plan).toEqual({
      mode: "expand",
      specialistSurfaces: ["technical_daily"],
      expandSurface: "technical_daily",
      publishMode: "summary_only",
    });
  });

  it("supports draft-only aggregate replies without specialist auto-publish", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "control_room",
      content: "今天该关注什么，给我一个总览，先别发到其他群，只做草稿",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: [
        "technical_daily",
        "fundamental_research",
        "knowledge_maintenance",
        "ops_audit",
      ],
      publishMode: "draft_only",
      replyContract: "default",
      includeDailyWorkface: true,
    });
  });

  it("keeps position-management questions in summary-only mode with a fixed reply contract", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "technical_daily",
      content: "我现在该不该减仓 QQQ，还是继续持有？",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["technical_daily"],
      publishMode: "summary_only",
      replyContract: "position_management",
    });
  });

  it("treats holdings-thesis revalidation asks as dual-track research instead of pure position management", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "control_room",
      content: "去研究最近的美股，用你已经有的知识去分析之前的持仓分析还成立吗",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance", "technical_daily", "fundamental_research"],
      publishMode: "summary_only",
      replyContract: "holdings_thesis_revalidation",
    });
  });

  it("treats 'old holdings thesis got punched by the market' asks as dual-track revalidation instead of plain position management", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "control_room",
      content: "如果之前那套持仓逻辑已经被市场打脸了，你就直接告诉我旧判断哪里失效，不要重新编一套",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance", "technical_daily", "fundamental_research"],
      publishMode: "summary_only",
      replyContract: "holdings_thesis_revalidation",
    });
  });

  it("treats 'old thesis still stands or not' asks as dual-track revalidation", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "control_room",
      content: "你不要给我复述旧观点，直接说以前那套 thesis 现在还站不站得住",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance", "technical_daily", "fundamental_research"],
      publishMode: "summary_only",
      replyContract: "holdings_thesis_revalidation",
    });
  });

  it("adds a dedicated control-room holdings-thesis revalidation notice instead of a generic overview notice", () => {
    const notice = buildFeishuControlRoomOrchestrationNotice({
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance", "technical_daily", "fundamental_research"],
      publishMode: "summary_only",
      replyContract: "holdings_thesis_revalidation",
    });

    expect(notice).toContain("This is a control-room holdings-thesis revalidation question");
    expect(notice).toContain(
      "Internal durable-state evidence is primary here: retrieve the prior holding analysis, old thesis summary, current-research-line when present",
    );
    expect(notice).toContain(
      "Use knowledge_maintenance to recover the old logic and correction trail, technical_daily to re-check the live driver and risk-transmission path, and fundamental_research to re-check business or issuer reality.",
    );
    expect(notice).toContain(
      "Load memory/local-memory/workflow-universal-finance-decision-under-uncertainty.md and use it as the internal decision frame here",
    );
    expect(notice).toContain(
      "lock the horizon, write one base_case, one bull_case, one bear_case, a subjective probability split, the main drivers, the key unknown, what changes my mind, action versus no-action, conviction_or_sizing, and invalidation.",
    );
    expect(notice).toContain(
      "Make four doctrine fields externally visible even in the concise control-room answer: the current base_case, the live bear_case, what_changes_my_mind, and why_no_action_may_be_better",
    );
    expect(notice).toContain(
      "Use these exact short labels when they are present in the final control-room answer: Base case:, Bear case:, What changes my mind:, Why no action may be better:.",
    );
    expect(notice).toContain(
      "also append these exact short calibration labels: Observed outcome:, Closest scenario:, Change-my-mind triggered:, Conviction looked:.",
    );
    expect(notice).toContain(
      "Keep calibration label values bounded and machine-readable: Closest scenario = base_case / bear_case / unclear; Change-my-mind triggered = yes / no / unclear; Conviction looked = too_high / too_low / about_right / unclear.",
    );
    expect(notice).toContain(
      "portfolio-sizing-discipline for size/hold-vs-add humility, risk-transmission for live macro/market path, behavior-error-correction for urgency theater or stubbornness, catalyst-map for real confirm/break events, and business-quality when issuer structure matters.",
    );
    expect(notice).toContain(
      "current base_case and what still holds from the old thesis, 2. live bear_case and what has weakened or broken, 3. what fresh evidence matters most now, 4. what_changes_my_mind plus invalidation, 5. one short next-step judgment including why_no_action_may_be_better when conviction is not high enough.",
    );
    expect(notice).not.toContain("Treat internal workflow or progress state as secondary");
  });

  it("keeps DS/statistics method questions on the learning-only aggregate path instead of dragging in technical_daily", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "learning_command",
      content:
        "我是学ds和统计的中国散户，你别给我讲市场大词，直接告诉我：如果我做ETF轮动，用样本外、walk-forward、bootstrap，什么结果才算没有自欺欺人？",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["learning_command"],
      publishMode: "classified_publish",
      replyContract: "default",
    });
  });

  it("keeps GitHub/open-source internalization asks on a learning-only aggregate path", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "learning_command",
      content: "去github上学习开源的值得你学的，并把值得内化的内化",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["learning_command"],
      publishMode: "classified_publish",
      replyContract: "default",
    });
  });

  it("keeps colloquial GitHub/open-source internalization asks on a learning-only aggregate path", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "learning_command",
      content: "去github上学值得你学的，但别做开源综述，直接告诉我哪些会改你以后的做法",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["learning_command"],
      publishMode: "classified_publish",
      replyContract: "default",
    });
  });

  it("keeps rough colloquial GitHub skill-stealing asks on a learning-only aggregate path", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "learning_command",
      content: "github上那些能偷的招你去偷，最后只说真会改你手法的三条，别做分享会",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["learning_command"],
      publishMode: "classified_publish",
      replyContract: "default",
    });
  });

  it("treats rough '前几天读那堆东西，到底留下啥了' asks as learning-internalization audit", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "knowledge_maintenance",
      content: "前几天读那堆东西，到底留下啥了，还是过眼云烟",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
      publishMode: "classified_publish",
      replyContract: "learning_internalization_audit",
    });
  });

  it("keeps correction carryover asks on the knowledge-maintenance aggregate path", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "knowledge_maintenance",
      content: "刚才那句回答太满了，下次别把没证据的东西说死",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance"],
      publishMode: "classified_publish",
      replyContract: "default",
    });
  });

  it("keeps source-grounding challenges on the ops-audit aggregate path", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "ops_audit",
      content: "这条判断是你确认过的还是猜的",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["ops_audit"],
      publishMode: "classified_publish",
      replyContract: "default",
    });
  });

  it("treats rough '前阵子学的那些长期记忆玩意儿，进规矩了没' asks as learning-internalization audit", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "knowledge_maintenance",
      content: "你前阵子学的那些长期记忆玩意儿，进规矩了没，还是嘴上热闹",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
      publishMode: "classified_publish",
      replyContract: "learning_internalization_audit",
    });
  });

  it("treats rough '上次学的那些花活有没有一条真改掉你老毛病' asks as learning-internalization audit", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "knowledge_maintenance",
      content: "别端水，就说上次学的那些花活有没有一条真改掉你老毛病",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
      publishMode: "classified_publish",
      replyContract: "learning_internalization_audit",
    });
  });

  it("treats rough '前阵子学过的东西又忘回去了' asks as learning-internalization audit", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "knowledge_maintenance",
      content: "你是不是把前阵子学过的东西又忘回去了",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
      publishMode: "classified_publish",
      replyContract: "learning_internalization_audit",
    });
  });

  it("treats rough '前阵子补的记忆那套，真进总线了还是边上堆垃圾' asks as learning-internalization audit", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "knowledge_maintenance",
      content: "前阵子补的记忆那套，真进总线了还是边上堆垃圾",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
      publishMode: "classified_publish",
      replyContract: "learning_internalization_audit",
    });
  });

  it("keeps LLM-finance-agent article learning asks on a learning-only aggregate path", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "learning_command",
      content: "去读关于llm应用在金融智能体上的文章，对你自我提升的启发",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["learning_command"],
      publishMode: "classified_publish",
      replyContract: "default",
    });
  });

  it("keeps anti-shallow internalization learning asks on a learning-only aggregate path", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "learning_command",
      content:
        "去看最近开源agent都怎么做长期记忆，然后只告诉我哪些真的值得你自己内化，别做表面总结",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["learning_command"],
      publishMode: "classified_publish",
      replyContract: "default",
    });
  });

  it("treats learning-internalization audit asks as knowledge-plus-ops audit instead of a four-way daily overview", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "knowledge_maintenance",
      content: "最近学的 openclaw 更新到底有没有内化成可复用规则，别给我做总结秀",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
      publishMode: "classified_publish",
      replyContract: "learning_internalization_audit",
    });
  });

  it("treats '沉淀成了哪些以后会复用的规则' asks as learning-internalization audit", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "knowledge_maintenance",
      content: "你先别总结，直接告诉我最近学的 openclaw 更新到底沉淀成了哪些以后会复用的规则",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
      publishMode: "classified_publish",
      replyContract: "learning_internalization_audit",
    });
  });

  it("treats background learning workflow audit asks as knowledge-plus-ops audit", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "knowledge_maintenance",
      content: "别给我一份总结，你就告诉我最近后台自动学习有没有卡住，卡在哪",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
      publishMode: "classified_publish",
      replyContract: "learning_workflow_audit",
    });
  });

  it("treats memory-vs-report audit asks as knowledge-plus-ops audit", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "knowledge_maintenance",
      content: "我昨天让你学的东西，现在到底写进记忆还是只是生成了报告",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
      publishMode: "classified_publish",
      replyContract: "learning_workflow_audit",
    });
  });

  it("treats rough workflow-audit asks about '写进脑子还是躺在 report 里装样子' as knowledge-plus-ops audit", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "knowledge_maintenance",
      content: "我前天让你学那个，现在是写进脑子了还是还躺在 report 里装样子",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
      publishMode: "classified_publish",
      replyContract: "learning_workflow_audit",
    });
  });

  it("treats rough workflow-audit asks about backend crash and fake recovery as knowledge-plus-ops audit", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "knowledge_maintenance",
      content: "你别给我整日报，我就问自动学习后台最近是不是死过机，后来是续上了还是装没事",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
      publishMode: "classified_publish",
      replyContract: "learning_workflow_audit",
    });
  });

  it("treats rough workflow-audit asks about a learning chain breaking mid-run as knowledge-plus-ops audit", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "knowledge_maintenance",
      content: "后台那条学习链是不是半路断过，然后又装作啥事没有",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
      publishMode: "classified_publish",
      replyContract: "learning_workflow_audit",
    });
  });

  it("treats rough workflow-audit asks about silent breakage as knowledge-plus-ops audit", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "knowledge_maintenance",
      content: "别装稳定，自动学习后台是不是自己断过又没报",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
      publishMode: "classified_publish",
      replyContract: "learning_workflow_audit",
    });
  });

  it("treats rough workflow-audit asks about not landing and only leaving files as knowledge-plus-ops audit", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "knowledge_maintenance",
      content: "那条后台学习是不是根本没落账，只是文件看着多",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
      publishMode: "classified_publish",
      replyContract: "learning_workflow_audit",
    });
  });

  it("treats rough workflow-audit asks about only leaving traces as knowledge-plus-ops audit", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "knowledge_maintenance",
      content: "自动学习后台是不是只会留痕，不会真落账",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
      publishMode: "classified_publish",
      replyContract: "learning_workflow_audit",
    });
  });

  it("treats 'upstream logic now invalid?' asks as dual-track revalidation", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "control_room",
      content: "我不是问现在买不买，我是问你上次那套逻辑现在是不是已经失效了",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance", "technical_daily", "fundamental_research"],
      publishMode: "summary_only",
      replyContract: "holdings_thesis_revalidation",
    });
  });

  it("treats rough '原来拿它的理由还剩几成' asks as dual-track revalidation", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "control_room",
      content: "别跟我说现在买卖，我问的是原来拿它的理由还剩几成",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance", "technical_daily", "fundamental_research"],
      publishMode: "summary_only",
      replyContract: "holdings_thesis_revalidation",
    });
  });

  it("treats rough '那套说法已经烂掉了' asks as dual-track revalidation", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "control_room",
      content: "如果你上次对QQQ那套说法已经烂掉了，就标出来哪句烂了，别重写",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance", "technical_daily", "fundamental_research"],
      publishMode: "summary_only",
      replyContract: "holdings_thesis_revalidation",
    });
  });

  it("treats rough '上回那个看多的由头现在还有活口没' asks as dual-track revalidation", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "control_room",
      content: "上回那个看多的由头现在还有活口没",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance", "technical_daily", "fundamental_research"],
      publishMode: "summary_only",
      replyContract: "holdings_thesis_revalidation",
    });
  });

  it("treats rough '原先撑着继续拿的那几个点，现在死了几个' asks as dual-track revalidation", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "control_room",
      content: "别跟我聊仓位，原先撑着继续拿的那几个点，现在死了几个",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance", "technical_daily", "fundamental_research"],
      publishMode: "summary_only",
      replyContract: "holdings_thesis_revalidation",
    });
  });

  it("treats rough '继续拿着的根据，现在是不是就剩嘴硬了' asks as dual-track revalidation", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "control_room",
      content: "之前那套继续拿着的根据，现在是不是就剩嘴硬了",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance", "technical_daily", "fundamental_research"],
      publishMode: "summary_only",
      replyContract: "holdings_thesis_revalidation",
    });
  });

  it("treats rough '之前那份看多理由现在塌了没' asks as dual-track revalidation", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "control_room",
      content: "别给我行情秀，我问的是之前那份看多理由现在塌了没",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance", "technical_daily", "fundamental_research"],
      publishMode: "summary_only",
      replyContract: "holdings_thesis_revalidation",
    });
  });

  it("treats rough '原来扛着不卖那点底气还剩几口气' asks as dual-track revalidation", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "control_room",
      content: "原来扛着不卖那点底气还剩几口气",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance", "technical_daily", "fundamental_research"],
      publishMode: "summary_only",
      replyContract: "holdings_thesis_revalidation",
    });
  });

  it("treats rough '之前死扛它那口气，现在还有没有道理' asks as dual-track revalidation", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "control_room",
      content: "之前死扛它那口气，现在还有没有道理",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance", "technical_daily", "fundamental_research"],
      publishMode: "summary_only",
      replyContract: "holdings_thesis_revalidation",
    });
  });

  it("treats rough '原来那份继续拿着的说法，现在还有没有骨头' asks as dual-track revalidation", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "control_room",
      content: "原来那份继续拿着的说法，现在还有没有骨头",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance", "technical_daily", "fundamental_research"],
      publishMode: "summary_only",
      replyContract: "holdings_thesis_revalidation",
    });
  });

  it("prioritizes holdings revalidation over meta-learning when the operator says finance comes first", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "control_room",
      content:
        "其他agent值得借的招先留着，以后再慢慢学；现在时间不多，先去学金融，然后帮我做持仓分析，看之前那套还站不站得住",
    });

    expect(plan).toEqual({
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance", "technical_daily", "fundamental_research"],
      publishMode: "summary_only",
      replyContract: "holdings_thesis_revalidation",
    });
  });

  it("does not orchestrate pure control commands", () => {
    const plan = resolveFeishuControlRoomOrchestration({
      currentSurface: "control_room",
      targetSurface: "control_room",
      content: "继续这个研究线",
      normalizedCommandText: "/new 继续这个研究线",
    });

    expect(plan).toBeUndefined();
  });
});

describe("buildFeishuControlRoomOrchestrationNotice", () => {
  it("renders aggregate orchestration guidance for a non-technical control-room summary", () => {
    const notice = buildFeishuControlRoomOrchestrationNotice({
      mode: "aggregate",
      specialistSurfaces: ["technical_daily", "fundamental_research"],
      publishMode: "classified_publish",
    });

    expect(notice).toContain("Control-room orchestration mode is active");
    expect(notice).toContain("Publish mode = classified_publish");
    expect(notice).toContain("technical_daily, fundamental_research");
    expect(notice).toContain("Control-room grounding contract");
    expect(notice).toContain("current-research-line and protected summaries first");
    expect(notice).toContain("dev-fixed means local implementation or tests only");
    expect(notice).toContain(
      "live-fixed means migrated, built, restarted, probed, and verified through the real Lark/Feishu path",
    );
    expect(notice).toContain("started/running/completed/blocked/unproven");
    expect(notice).toContain("say unproven or unknown");
    expect(notice).toContain("Optimize for a normal user");
    expect(notice).toContain("Return one clear control-room summary first");
    expect(notice).toContain(
      "For daily or morning reports, combine the seven decision foundations into one concise brief when relevant",
    );
    expect(notice).toContain("give a useful low-fidelity overview first");
    expect(notice).toContain("acknowledge it briefly in one short phrase");
    expect(notice).toContain("do not present high-specificity market figures");
    expect(notice).toContain(
      "prefer directional wording, scenario framing, and missing-anchor language",
    );
    expect(notice).toContain("workflow or progress state as secondary");
    expect(notice).toContain("Do not make file-maintenance actions");
    expect(notice).toContain("label the view as low-fidelity or provisional");
    expect(notice).toContain("no precise trading-style conviction");
    expect(notice).toContain("decision support, not prediction theater");
    expect(notice).toContain("Sound like an orchestrator");
    expect(notice).toContain(
      "expand technical / expand fundamental / expand ops / expand knowledge",
    );
    expect(notice).toContain("## Control Summary, ## Technical Slice");
    expect(notice).toContain(
      "publish: yes|no, confidence: high|medium|low, and when relevant foundations: <one-or-two dominant foundation templates>",
    );
    expect(notice).toContain(
      "prefer naming the one or two dominant foundations that actually drive the slice",
    );
    expect(notice).toContain("Do not auto-publish low-confidence");
  });

  it("renders human-first workface guidance for daily operating briefs", () => {
    const notice = buildFeishuControlRoomOrchestrationNotice({
      mode: "aggregate",
      specialistSurfaces: [
        "technical_daily",
        "fundamental_research",
        "knowledge_maintenance",
        "ops_audit",
      ],
      publishMode: "classified_publish",
      replyContract: "default",
      includeDailyWorkface: true,
    });

    expect(notice).toContain("For daily workface or health-style asks");
    expect(notice).toContain("translate them into plain operator language first");
  });

  it("renders the fixed position-management contract for summary-only control-room asks", () => {
    const notice = buildFeishuControlRoomOrchestrationNotice({
      mode: "aggregate",
      specialistSurfaces: ["technical_daily"],
      publishMode: "summary_only",
      replyContract: "position_management",
    });

    expect(notice).toContain("This is a control-room position-management question");
    expect(notice).toContain(
      "Keep the answer in control_room, do not auto-publish specialist slices",
    );
    expect(notice).toContain(
      "current stance, key reasons, main counter-case / risk, action triggers, confidence, one-line summary",
    );
    expect(notice).toContain(
      "Explicitly apply the portfolio sizing discipline template: name any concentration risk, distinguish conviction from actual size",
    );
    expect(notice).toContain(
      "If the question depends on macro or cross-asset context, apply the risk transmission template: identify the live driver, the transmission path, the assets most exposed, and one invalidation path",
    );
    expect(notice).toContain(
      "## Current Stance, ## Key Reasons, ## Main Counter-Case / Risk, ## Action Triggers, ## Confidence, ## One-Line Summary",
    );
    expect(notice).toContain("Current stance should be one clear label only");
    expect(notice).toContain("Action triggers must be split into Add / Reduce / Wait");
    expect(notice).toContain("Confidence should be low, medium, or high");
    expect(notice).toContain(
      "Use execution hygiene discipline too: if event risk, liquidity, or volatility makes the setup noisy, say wait explicitly instead of forcing action",
    );
    expect(notice).toContain(
      "Also check the behavior-error-correction template: name any urgency theater, confirmation bias, narrative overreach, or discomfort-with-waiting that could be distorting the stance",
    );
    expect(notice).toContain(
      "If the position depends on a known event path, use the catalyst-map template too: separate what would truly confirm, what would truly break, and what is mostly noise",
    );
  });

  it("renders a dedicated control-room contract for learning-internalization audits", () => {
    const notice = buildFeishuControlRoomOrchestrationNotice({
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
      publishMode: "classified_publish",
      replyContract: "learning_internalization_audit",
    });

    expect(notice).toContain("This is a control-room learning-internalization audit");
    expect(notice).toContain("Internal durable-state evidence is primary here, not secondary");
    expect(notice).toContain("latest learning outputs, protected summaries when present");
    expect(notice).toContain("what genuinely stuck, what still looks shallow");
    expect(notice).not.toContain("Treat internal workflow or progress state as secondary");
    expect(notice).not.toContain("Keep internal workflow status secondary");
  });

  it("renders a dedicated control-room contract for learning-workflow audits", () => {
    const notice = buildFeishuControlRoomOrchestrationNotice({
      mode: "aggregate",
      specialistSurfaces: ["knowledge_maintenance", "ops_audit"],
      publishMode: "classified_publish",
      replyContract: "learning_workflow_audit",
    });

    expect(notice).toContain("This is a control-room learning-workflow audit");
    expect(notice).toContain("Workflow and durable-state evidence are primary here, not secondary");
    expect(notice).toContain("learning carryover cue, protected summaries when present");
    expect(notice).toContain("what reached durable memory versus report-only output");
    expect(notice).not.toContain("Treat internal workflow or progress state as secondary");
    expect(notice).not.toContain("Keep internal workflow status secondary");
  });

  it("renders expand follow-up guidance for a single specialist slice", () => {
    const notice = buildFeishuControlRoomOrchestrationNotice({
      mode: "expand",
      specialistSurfaces: ["ops_audit"],
      expandSurface: "ops_audit",
      publishMode: "summary_only",
    });

    expect(notice).toContain("Publish mode = summary_only");
    expect(notice).toContain("Expand follow-up detected");
    expect(notice).toContain("ops_audit");
    expect(notice).toContain("Control-room grounding contract");
    expect(notice).toContain("reply-flow evidence when available");
    expect(notice).toContain("Keep the reply in the control room");
    expect(notice).toContain("Sound like an orchestrator");
    expect(notice).toContain("workflow or file-maintenance notes secondary");
  });
});

describe("classified publish parsing", () => {
  it("parses structured control-room artifacts with metadata", () => {
    const artifacts = parseFeishuClassifiedArtifacts(`
## Control Summary
今天先看风险框架，不追高。

## Technical Slice
publish: yes
confidence: medium
foundations: risk-transmission, execution-hygiene
QQQ 相对利率更敏感，先看 10Y 与风险偏好是否继续共振走弱。

## Fundamental Slice
publish: no
confidence: low
财报更新还不完整，先保留为草稿。
`);

    expect(artifacts).toHaveLength(3);
    expect(artifacts[0]).toMatchObject({
      type: "control_summary",
      body: "今天先看风险框架，不追高。",
    });
    expect(artifacts[1]).toMatchObject({
      type: "technical_slice",
      publishRequested: true,
      confidence: "medium",
      foundations: ["risk-transmission", "execution-hygiene"],
    });
    expect(artifacts[2]).toMatchObject({
      type: "fundamental_slice",
      publishRequested: false,
      confidence: "low",
    });
  });

  it("routes only publishable slices and holds low-confidence slices as draft", () => {
    const classified = resolveFeishuClassifiedPublishResult({
      cfg: {
        surfaces: {
          technical_daily: { chatId: "oc-tech" },
          fundamental_research: { chatId: "oc-fund" },
        },
      } as FeishuConfig,
      publishMode: "classified_publish",
      specialistSurfaces: ["technical_daily", "fundamental_research"],
      text: `
## Control Summary
先看利率和风险偏好，别急着加仓。

## Technical Slice
publish: yes
confidence: high
QQQ / SPY / TLT 先看谁对长端利率更敏感。

## Fundamental Slice
publish: yes
confidence: low
这条还是 low-fidelity，先别自动发。
`,
    });

    expect(classified.controlSummary).toBe("先看利率和风险偏好，别急着加仓。");
    expect(classified.publishTargets).toEqual([
      {
        artifactType: "technical_slice",
        surface: "technical_daily",
        chatId: "oc-tech",
      },
    ]);
    expect(classified.draftArtifacts.map((artifact) => artifact.type)).toEqual([
      "fundamental_slice",
    ]);
    expect(classified.distributionSummary).toContain("published technical slice");
    expect(classified.distributionSummary).toContain("held as draft fundamental slice");
  });
});
