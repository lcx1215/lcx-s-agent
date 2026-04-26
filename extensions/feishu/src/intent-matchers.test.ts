import { describe, expect, it } from "vitest";
import {
  looksLikeBatchQueueScopeAsk,
  looksLikeBoundedPriorityScopeAsk,
  looksLikeCapabilityClaimScopeAsk,
  looksLikeClassifyWorkScopeAsk,
  looksLikeClarificationBoundaryScopeAsk,
  looksLikeCompletionProofScopeAsk,
  looksLikeCorrectionCarryoverAsk,
  looksLikeDurableMemoryScopeAsk,
  looksLikeEvidenceShapeScopeAsk,
  looksLikeExecutionAuthorityScopeAsk,
  looksLikeExplicitResearchLineContinuationAsk,
  looksLikeFailureReportScopeAsk,
  looksLikeHoldingsRevalidationAsk,
  looksLikeHighStakesRiskScopeAsk,
  looksLikeInstructionConflictScopeAsk,
  looksLikeLearningInternalizationAuditAsk,
  looksLikeLearningTimeboxStatusAsk,
  looksLikeLearningWorkflowAuditAsk,
  looksLikeMarketIntelligencePacketAsk,
  looksLikeNegatedScopeCorrectionAsk,
  looksLikeOutOfScopeBoundaryAsk,
  looksLikeProgressStatusScopeAsk,
  looksLikeResultShapeScopeAsk,
  looksLikeRoleExpansionScopeAsk,
  looksLikeSourceCoverageScopeAsk,
  looksLikeSourceGroundingAsk,
  looksLikeStrategicLearningAsk,
  looksLikeTemporalScopeControlAsk,
} from "./intent-matchers.js";

describe("feishu intent matchers", () => {
  it("detects rough learning-internalization audit asks", () => {
    expect(
      looksLikeLearningInternalizationAuditAsk("前几天读那堆东西，到底留下啥了，还是过眼云烟"),
    ).toBe(true);
  });

  it("detects rough learning-workflow audit asks", () => {
    expect(
      looksLikeLearningWorkflowAuditAsk("后台那条学习链是不是半路断过，然后又装作啥事没有"),
    ).toBe(true);
  });

  it("detects correction carryover asks by family cues", () => {
    const positiveCases = [
      "刚才那句回答太满了，下次别把没证据的东西说死",
      "这条规则记住，以后遇到 provider 没确认就别说已经接上",
      "你刚才把 session 理解说成长期记忆了，改掉这个习惯",
      "上面那个回答不对，记下来以后别再这样",
    ];

    for (const phrase of positiveCases) {
      expect(looksLikeCorrectionCarryoverAsk(phrase), phrase).toBe(true);
    }

    expect(looksLikeCorrectionCarryoverAsk("今天如果看错了，最可能错在哪条线")).toBe(false);
    expect(looksLikeCorrectionCarryoverAsk("帮我红队一下 market regime 这条线")).toBe(false);
  });

  it("detects source-grounding challenges without catching normal research requests", () => {
    const positiveCases = [
      "你这句话哪来的，给我出处",
      "刚才那个结论有来源吗",
      "这条判断是你确认过的还是猜的",
      "没源没证据就说不知道，别编",
    ];

    for (const phrase of positiveCases) {
      expect(looksLikeSourceGroundingAsk(phrase), phrase).toBe(true);
    }

    expect(looksLikeSourceGroundingAsk("给我找几篇有来源的 AI capex 文章")).toBe(false);
    expect(looksLikeSourceGroundingAsk("研究 MSFT 财报时列出来源")).toBe(false);
  });

  it("detects explicit research-line continuation by family cues", () => {
    const positiveCases = [
      "别换线，沿着上一轮继续下一步",
      "接着刚才那条研究线往下做",
      "这条线先别开新分支，继续收敛",
      "上一轮那个结论接着推进",
      "continue the current line",
    ];

    for (const phrase of positiveCases) {
      expect(looksLikeExplicitResearchLineContinuationAsk(phrase), phrase).toBe(true);
    }

    expect(looksLikeExplicitResearchLineContinuationAsk("继续分析一下这家公司的财报差异")).toBe(
      false,
    );
    expect(looksLikeExplicitResearchLineContinuationAsk("把 AI capex 这条线给我讲清楚")).toBe(
      false,
    );
    expect(
      looksLikeExplicitResearchLineContinuationAsk(
        "按优先级先做一个最小可验证 patch，别扩新分支，写代码并保存文件",
      ),
    ).toBe(false);
  });

  it("detects negated-scope correction asks without treating every prohibition as a redirect", () => {
    const positiveCases = [
      "我不是让你重写长文，我是让你先说动作和范围",
      "不是问你现在买不买，是问旧逻辑哪里失效",
      "别做开源综述，只留下能改你做法的规则",
      "不要重新编一套，先标出哪句旧判断失效",
      "not asking for a summary, just tell me what changed",
    ];

    for (const phrase of positiveCases) {
      expect(looksLikeNegatedScopeCorrectionAsk(phrase), phrase).toBe(true);
    }

    expect(looksLikeNegatedScopeCorrectionAsk("不要买 QQQ")).toBe(false);
    expect(looksLikeNegatedScopeCorrectionAsk("别追高")).toBe(false);
  });

  it("detects temporal-scope control asks without catching every dated request", () => {
    const positiveCases = [
      "我问的是现在状态，别拿昨天的失败回答",
      "今天的搜索能力用今天的证据说，别引用上次坏掉那次",
      "上次那个结论现在还成立吗，别把旧证据当当前状态",
      "最近七天的学习不要混成今天已经落盘",
      "right now status, do not use stale prior evidence",
    ];

    for (const phrase of positiveCases) {
      expect(looksLikeTemporalScopeControlAsk(phrase), phrase).toBe(true);
    }

    expect(looksLikeTemporalScopeControlAsk("今天该关注什么")).toBe(false);
    expect(looksLikeTemporalScopeControlAsk("昨天学了什么")).toBe(false);
  });

  it("detects bounded-priority scope asks without catching generic continuation", () => {
    const positiveCases = [
      "继续，但一次只做一个语义家族",
      "按优先级先做一个最小可验证 patch",
      "不要扩新分支，下一步只补一个最高价值方向",
      "别发散，先收敛一个 failure mode 并给 proof",
      "one family only, no branching, give me the next step",
    ];

    for (const phrase of positiveCases) {
      expect(looksLikeBoundedPriorityScopeAsk(phrase), phrase).toBe(true);
    }

    expect(looksLikeBoundedPriorityScopeAsk("继续")).toBe(false);
    expect(looksLikeBoundedPriorityScopeAsk("下一步")).toBe(false);
  });

  it("detects completion-proof scope asks without catching ordinary completion wording", () => {
    const positiveCases = [
      "别把开始当完成，告诉我现在只是 planned 还是 verified",
      "你到底做完了没有，proof 是什么",
      "不要把已经理解说成已经落盘，给我 receipt",
      "started 和 completed 分开说",
      "别把 notice 当 proof",
      "did it actually finish or only start",
    ];

    for (const phrase of positiveCases) {
      expect(looksLikeCompletionProofScopeAsk(phrase), phrase).toBe(true);
    }

    expect(looksLikeCompletionProofScopeAsk("开始学习这个主题")).toBe(false);
    expect(looksLikeCompletionProofScopeAsk("完成以后告诉我")).toBe(false);
  });

  it("detects execution-authority scope asks without catching ordinary implementation", () => {
    const positiveCases = [
      "别把研究建议说成已经下单，research-only",
      "我没授权你交易，买卖只能说研究判断",
      "不要假装已经发出去，真实外部系统动作要说没有权限",
      "执行和建议分开说，不能把 paper trade 当 live trade",
      "do not execute real trades, this is research-only",
      "not authorized to publish or delete anything in production",
      "你可以操控电脑做 Lark 真实对话测试，但这不等于授权 build/restart/deploy",
      "允许你操作 Lark 可见面 probe，但部署和重启仍需单独 proof",
      "permission to operate Lark does not mean production restart is authorized",
      "本次授权只覆盖 Lark probe，不能继承到下一轮 deploy 或 restart",
      "每次 live action 都要单独授权，上一条允许操控电脑不等于这次可以重启",
      "per-action permission: operating Lark does not carry over to later production actions",
      "撤回授权，别接 live，也别再 probe，只保留 dev patch",
      "stop live and do not probe; previous permission is revoked",
    ];

    for (const phrase of positiveCases) {
      expect(looksLikeExecutionAuthorityScopeAsk(phrase), phrase).toBe(true);
    }

    expect(looksLikeExecutionAuthorityScopeAsk("写代码并保存文件")).toBe(false);
    expect(looksLikeExecutionAuthorityScopeAsk("QQQ 现在还能拿吗")).toBe(false);
  });

  it("detects source-coverage scope asks without catching ordinary source learning", () => {
    const positiveCases = [
      "去 Google 上学，但别把看了几个来源说成完整覆盖",
      "网上查全这个 agent memory 做法，覆盖范围和没搜到的都说清楚",
      "看 GitHub 和论文时标明 source coverage，不要假装 exhaustive",
      "如果搜索不可用，就别说已经学完所有外部材料",
      "study competitor docs, but label sample limits and unknowns",
      "do a web search survey and say whether it is full coverage or partial",
    ];

    for (const phrase of positiveCases) {
      expect(looksLikeSourceCoverageScopeAsk(phrase), phrase).toBe(true);
    }

    expect(looksLikeSourceCoverageScopeAsk("去 Google 上学最近 agent 记忆怎么做")).toBe(false);
    expect(looksLikeSourceCoverageScopeAsk("搜索现在能用吗")).toBe(false);
  });

  it("detects durable-memory scope asks without catching ordinary notes", () => {
    const positiveCases = [
      "记住这条规则，但别把聊天里理解说成已经进长期记忆",
      "写进 memory 之前说清楚是普通 artifact 还是 protected memory",
      "不要假装已经接入 recall order，没接入就说只是落了 note",
      "以后别再犯这条，要区分临时上下文和 durable memory",
      "do not claim long-term memory unless it is persisted and recallable",
      "separate ephemeral context from protected memory write",
    ];

    for (const phrase of positiveCases) {
      expect(looksLikeDurableMemoryScopeAsk(phrase), phrase).toBe(true);
    }

    expect(looksLikeDurableMemoryScopeAsk("记一下这个标题")).toBe(false);
    expect(looksLikeDurableMemoryScopeAsk("以后继续分析 QQQ")).toBe(false);
  });

  it("detects classify-work scope asks without catching ordinary classification", () => {
    const positiveCases = [
      "先判断这句话属于哪类工作，再决定怎么干活",
      "这类语句要按语义家族分类处理，不要按句子硬套",
      "识别任务类型、证据状态和输出合同，然后再回答",
      "先分辨该走哪个 surface 或角色，再执行最小下一步",
      "classify the intent family before acting",
      "categorize the work type and route it to the right lane",
    ];

    for (const phrase of positiveCases) {
      expect(looksLikeClassifyWorkScopeAsk(phrase), phrase).toBe(true);
    }

    expect(looksLikeClassifyWorkScopeAsk("把这些公司按行业分类")).toBe(false);
    expect(looksLikeClassifyWorkScopeAsk("这句话是什么意思")).toBe(false);
  });

  it("detects capability-claim scope asks without catching ordinary capability questions", () => {
    const positiveCases = [
      "现在 Lark 搜索能力能用吗，别把 dev-fixed 说成 live-fixed",
      "这个 provider 是不是已经接上了，用当前证据说，没验过就标 unverified",
      "已经支持自动学习了吗，区分设计目标、本地测试和 live 状态",
      "这个 routing 现在真的生效了吗，给 proof 或 acceptance phrase",
      "Lark 真实对话没问题的就接 live 跟上，别把 dev-fixed 当 live-fixed",
      "这个 prompt guard 是 dev-fixed 还是已经 build/restart 后 live 生效了",
      "接到线上之前先说清楚 build、restart、probe 哪个做了",
      "接 live 前先定义验收短语，没命中 acceptance phrase 就别说 live-fixed",
      "is web search available right now, do not use stale proof",
      "is the integration wired in production or only locally tested",
    ];

    for (const phrase of positiveCases) {
      expect(looksLikeCapabilityClaimScopeAsk(phrase), phrase).toBe(true);
    }

    expect(looksLikeCapabilityClaimScopeAsk("搜索现在能用吗")).toBe(false);
    expect(looksLikeCapabilityClaimScopeAsk("这个功能怎么用")).toBe(false);
  });

  it("detects clarification-boundary scope asks without catching every vague phrase", () => {
    const positiveCases = [
      "如果对象不清楚，先问一个窄澄清问题，别硬猜",
      "目标、时间窗和动作边界不明确时，先澄清再干活",
      "proof 要求缺了就问我一句，不要直接做",
      "这个 scope 模糊时先确认一下 surface 和输出合同",
      "when the target is ambiguous, ask one narrow clarification before acting",
      "do not guess if the timeframe or action boundary is underspecified",
    ];

    for (const phrase of positiveCases) {
      expect(looksLikeClarificationBoundaryScopeAsk(phrase), phrase).toBe(true);
    }

    expect(looksLikeClarificationBoundaryScopeAsk("继续")).toBe(false);
    expect(looksLikeClarificationBoundaryScopeAsk("这句话是什么意思")).toBe(false);
  });

  it("detects instruction-conflict scope asks without catching ordinary negation", () => {
    const positiveCases = [
      "继续但别继续这条线，先指出冲突再收敛",
      "写代码但不要改文件，这两个动作冲突时先说清楚",
      "查最新但不要联网，先标出证据冲突",
      "要验证 proof 但别运行命令，按优先级只执行兼容动作",
      "continue but do not continue this line; state the conflict first",
      "browse for current evidence with no network, resolve the contradiction",
    ];

    for (const phrase of positiveCases) {
      expect(looksLikeInstructionConflictScopeAsk(phrase), phrase).toBe(true);
    }

    expect(looksLikeInstructionConflictScopeAsk("不要买 QQQ")).toBe(false);
    expect(looksLikeInstructionConflictScopeAsk("别联网，直接用已有资料总结")).toBe(false);
  });

  it("detects out-of-scope boundary asks without catching ordinary refusal", () => {
    const positiveCases = [
      "这次不做 live 验证，只做 dev prompt guard 和测试",
      "别碰 protected memory，允许新增独立 note，并说清楚 out of scope",
      "不要扩新分支，只做一个最小可验证 patch",
      "不接新工具，下一步只补 Lark 语义理解",
      "别接 live，停止 probe，只做 dev prompt guard",
      "pause live verification and only update local tests",
      "exclude deployment and only update the local matcher tests",
      "do not touch live state; smallest in-scope action only",
    ];

    for (const phrase of positiveCases) {
      expect(looksLikeOutOfScopeBoundaryAsk(phrase), phrase).toBe(true);
    }

    expect(looksLikeOutOfScopeBoundaryAsk("不要买 QQQ")).toBe(false);
    expect(looksLikeOutOfScopeBoundaryAsk("别联网，直接用已有资料总结")).toBe(false);
  });

  it("detects high-stakes risk scope asks without catching ordinary research", () => {
    const positiveCases = [
      "QQQ 现在要不要卖，先标风险和权限边界",
      "直接帮我下单前先说清楚你没有交易授权",
      "这个生产库能不能删，给 proof 和安全下一步",
      "法律合同这个条款该不该签，先标 high-stakes 和证据缺口",
      "should I change medication, identify medical risk and say what is safe",
      "deploy to production only if authority and verification are clear",
    ];

    for (const phrase of positiveCases) {
      expect(looksLikeHighStakesRiskScopeAsk(phrase), phrase).toBe(true);
    }

    expect(looksLikeHighStakesRiskScopeAsk("研究一下 QQQ 最近风险")).toBe(false);
    expect(looksLikeHighStakesRiskScopeAsk("总结一下生产系统日志")).toBe(false);
  });

  it("detects result-shape scope asks without catching ordinary summaries", () => {
    const positiveCases = [
      "只给结论和 proof，不要长文",
      "先给摘要，再列 excluded / in-scope / next step",
      "按 checklist 输出：风险、证据、下一步",
      "用表格列出状态、proof 和剩余风险",
      "short answer only: summary, evidence, next step",
      "format as bullets with conclusion first and receipt last",
    ];

    for (const phrase of positiveCases) {
      expect(looksLikeResultShapeScopeAsk(phrase), phrase).toBe(true);
    }

    expect(looksLikeResultShapeScopeAsk("总结一下今天市场")).toBe(false);
    expect(looksLikeResultShapeScopeAsk("给我一个结论")).toBe(false);
  });

  it("detects evidence-shape scope asks without catching ordinary sourced research", () => {
    const positiveCases = [
      "按 claim / source / status / gap 列 proof",
      "每条判断标 verified / unverified，没证据就说不知道",
      "给 citation 表格，分开证据、推断和缺口",
      "不要编来源，引用缺失就标 no source",
      "Lark 真实对话测试后给测试回执：测试语句、可见回复、通过/不通过、dev/live 边界、下一步",
      "Lark 测试回执要标同一个 chat / thread、对应回复和 message-time，别拿旧回复当 proof",
      "live 回执要列 acceptance phrase、是否命中、可见回复和 dev/live 边界",
      "等价语义验收要列核心槽位、命中槽位、缺失槽位，缺了就不能 pass",
      "visible reply receipt: tested phrase, pass/fail, dev-fixed vs live-fixed, next step",
      "show acceptance phrase match status in the visible reply receipt",
      "equivalent semantic match must show core slots, matched slots, and missing slots",
      "visible reply evidence must show same thread, matching reply, and tested phrase",
      "format evidence as claim, receipt, status, missing proof",
      "cite sources and mark inferred claims separately",
    ];

    for (const phrase of positiveCases) {
      expect(looksLikeEvidenceShapeScopeAsk(phrase), phrase).toBe(true);
    }

    expect(looksLikeEvidenceShapeScopeAsk("研究 MSFT 财报时列出来源")).toBe(false);
    expect(looksLikeEvidenceShapeScopeAsk("给我找几篇有来源的文章")).toBe(false);
  });

  it("detects failure-report scope asks without catching ordinary failure mentions", () => {
    const positiveCases = [
      "失败了没，按 status / blocker / proof / next step 报",
      "哪里卡住了，别装成功，给影响和修复下一步",
      "如果 degraded，就说清楚原因、证据和剩余风险",
      "别报喜，没跑通就按失败报告格式说",
      "Lark 探针发出后无回复，按 blocked / proof / next step 报，不要说通过",
      "只发送了测试消息但没看到可见回复，标 degraded，不要 claim pass",
      "看到的是旧回复或错线程回复，按 blocked 报，不要当通过",
      "visible reply is from the wrong chat or does not match the tested phrase; report blocker",
      "live probe timed out with no visible reply; report blocker and evidence",
      "report degraded state with blocker, impact, evidence, next step",
      "do not claim success if proof is missing; give honest status",
    ];

    for (const phrase of positiveCases) {
      expect(looksLikeFailureReportScopeAsk(phrase), phrase).toBe(true);
    }

    expect(looksLikeFailureReportScopeAsk("这个测试失败了")).toBe(false);
    expect(looksLikeFailureReportScopeAsk("哪里可以优化")).toBe(false);
  });

  it("detects progress-status scope asks without catching generic next-step prompts", () => {
    const positiveCases = [
      "现在做到哪了，已完成、进行中、阻塞、下一步分别说",
      "还剩什么，别只说开始了，要 proof 和 next step",
      "当前进度按 done / in progress / blocked / remaining 输出",
      "做到哪里了，哪些文件改了，剩余风险是什么",
      "Lark live probe 现在只是 sent 还是已经看到 visible reply，按 done / blocked / next step 说",
      "测试消息只发出但还没回复，别把 only sent 当 done",
      "status update: completed, in progress, blocked, remaining, next step",
      "where are we, what is done, what remains, and what proof exists",
    ];

    for (const phrase of positiveCases) {
      expect(looksLikeProgressStatusScopeAsk(phrase), phrase).toBe(true);
    }

    expect(looksLikeProgressStatusScopeAsk("下一步")).toBe(false);
    expect(looksLikeProgressStatusScopeAsk("继续")).toBe(false);
  });

  it("detects role-expansion scope asks without catching ordinary specialist topics", () => {
    const positiveCases = [
      "先给 control-room summary，再 expand technical",
      "展开 fundamental 细节，但不要抢主摘要",
      "切到 ops 角色看 failure proof",
      "knowledge specialist 只展开可复用规则",
      "summary first, then specialist detail for technical",
      "switch role to ops lane but keep control-room summary first",
    ];

    for (const phrase of positiveCases) {
      expect(looksLikeRoleExpansionScopeAsk(phrase), phrase).toBe(true);
    }

    expect(looksLikeRoleExpansionScopeAsk("分析一下 technical signal")).toBe(false);
    expect(looksLikeRoleExpansionScopeAsk("fundamental research for MSFT")).toBe(false);
  });

  it("detects batch-queue scope asks without catching ordinary lists", () => {
    const positiveCases = [
      "这些都做，但按优先级排队，一次一个",
      "批量处理这几项，先做前两个，不要并行",
      "把任务队列列出来，标 queued / done / remaining",
      "多个语义家族先排序，只执行 next item",
      "queue these tasks by priority and do one at a time",
      "process the first two only, leave the rest queued",
    ];

    for (const phrase of positiveCases) {
      expect(looksLikeBatchQueueScopeAsk(phrase), phrase).toBe(true);
    }

    expect(looksLikeBatchQueueScopeAsk("列出这几个 ETF")).toBe(false);
    expect(looksLikeBatchQueueScopeAsk("给我一个任务列表")).toBe(false);
  });

  it("detects holdings-thesis revalidation asks", () => {
    expect(looksLikeHoldingsRevalidationAsk("原来扛着不卖那点底气还剩几口气")).toBe(true);
  });

  it("detects mixed and colloquial learning-session status asks", () => {
    expect(looksLikeLearningTimeboxStatusAsk("学习 session 现在还活着吗")).toBe(true);
    expect(looksLikeLearningTimeboxStatusAsk("我刚才让你学的那条还在跑吗")).toBe(true);
    expect(looksLikeLearningTimeboxStatusAsk("今天系统最脏的地方是什么")).toBe(false);
  });

  it("detects bounded same-day market-intelligence packet asks", () => {
    expect(
      looksLikeMarketIntelligencePacketAsk(
        "今天做一个 ETF / macro intelligence packet，给我 SPY QQQ rates dollar 的情报包",
      ),
    ).toBe(true);
    expect(looksLikeMarketIntelligencePacketAsk("继续这个学习")).toBe(false);
  });

  it("detects external-source learning asks by family cues instead of fixed sentences", () => {
    const positiveCases = [
      "去 Google 上学最近 agent 记忆怎么做，只留下会改你以后做法的三条",
      "网上搜一下最近金融智能体文章，别复述文章，只说哪些值得内化",
      "查一下 arxiv 上 agent workflow 的新文章，筛出以后会复用的规则",
      "去看几篇 blog 和 docs，别做综述，只留下能改你研究流程的东西",
      "去 Google 上学半个小时，学 agent 记忆怎么做",
      "从网上找资料持续学30分钟，主题是 finance agent workflow",
      "看看同类 agent 怎么做长期记忆，筛出能改你工作流的规则",
      "找几个竞品智能体的做法参考一下，别做综述，只留下可复用的",
    ];

    for (const phrase of positiveCases) {
      expect(looksLikeStrategicLearningAsk(phrase), phrase).toBe(true);
    }

    expect(looksLikeStrategicLearningAsk("搜索现在能用吗")).toBe(false);
    expect(looksLikeStrategicLearningAsk("google 一下天气")).toBe(false);
  });
});
