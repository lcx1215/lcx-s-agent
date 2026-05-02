export function normalizeFeishuIntentText(text: string): string {
  return text.trim().toLowerCase();
}

export function looksLikeMethodLearningTopic(text: string): boolean {
  const normalized = normalizeFeishuIntentText(text);
  const hasLearningIntent =
    /(想学|去学|学一下|学会|补一下|加强|研究一下|研究明白|搞懂|内化|框架|方法|用到|别讲空话|值得记住|反复用|练什么|怎么练|怎么用|怎么判断|怎么检验|怎么验证|怎么避免|直接告诉我|别给我讲)/u.test(
      normalized,
    );
  const hasMethodCue =
    /(ds\b|data science|数据科学|统计学|统计|统计检验|显著性|显著性检验|回归|bootstrap|样本外|out[-\s]?of[-\s]?sample|交叉验证|cross[-\s]?validation|walk[-\s]?forward|稳健性|因子检验|因子测试)/u.test(
      normalized,
    );
  return hasLearningIntent && hasMethodCue;
}

export function looksLikeVerticalFinanceLearningAsk(text: string): boolean {
  const normalized = normalizeFeishuIntentText(text);
  const hasLearningIntent =
    /(开始学|开始学习|去学|学一下|学学|学习|学会|训练|练出|练好|补一下|补齐|补强|提升|强化|加强|研究一下|研究明白|搞懂|内化|做成能力|能力做好|能力补齐|接下来学|让它学|让你学|你去学)/u.test(
      normalized,
    );
  const hasVerticalCue =
    /(垂直|专业|专门|vertical|domain|领域|主线|能力|脑子|大脑|语言接口|对话接口|研究能力|分析能力|判断能力|筛选能力|过滤能力)/u.test(
      normalized,
    );
  const hasFinanceDomain =
    /(股市|股票|美股|a股|港股|市场|金融|finance|etf|指数|index|大类资产|major asset|资产配置|持仓|组合|portfolio|基本面|fundamental|技术面|technical|日频|daily[-\s]?frequency|择时|timing|风控|risk control|风险控制|回撤|drawdown|仓位|position sizing|筛股|选股|行业|板块|财报|估值|valuation)/u.test(
      normalized,
    );
  return hasLearningIntent && hasVerticalCue && hasFinanceDomain;
}

export function looksLikeFinanceLearningPipelineAsk(text: string): boolean {
  const normalized = normalizeFeishuIntentText(text);
  const hasExplicitPipelineExecutionCue =
    /(finance[_\s-]?learning[_\s-]?pipeline[_\s-]?orchestrator|source intake|extract|attach|retrieval review|retrieval receipt|learninginternalizationstatus|application[_\s-]?ready|failedreason|usable answer contract|usable answer lines)/iu.test(
      normalized,
    );
  const hasLearningIntent =
    /(开始学|开始学习|去学|学一下|学学|学习|学会|学成|训练|练出|练好|补一下|补齐|补强|提升|强化|加强|研究一下|研究明白|搞懂|内化|做成能力|能力做好|能力补齐|接下来学|让它学|让你学|你去学|你自己学|自己学|learn|study|internalize)/u.test(
      normalized,
    );
  const hasFinanceDomain =
    /(股市|股票|美股|a股|港股|市场|金融|finance|etf|指数|index|大类资产|major asset|资产配置|持仓|组合|portfolio|基本面|fundamental|技术面|technical|日频|daily[-\s]?frequency|择时|timing|风控|risk control|风险控制|回撤|drawdown|仓位|position sizing|筛股|选股|行业|板块|财报|估值|valuation|量化|quant|因子|factor|策略|strategy|regime|宏观|利率|信用|credit|流动性|liquidity)/u.test(
      normalized,
    );
  const hasPipelineCue =
    /(能力|能力卡|capability|capability card|pipeline|管线|receipt|review|日结|检索|retrieval|内化|可检索|学成|做成|沉淀|attach|extract|source intake|学习流程|完整学习流程|一套|方法|框架|策略|workflow|checklist|规则|rule)/u.test(
      normalized,
    );
  const hasFinanceMethodKnowledgeCue =
    /(数学|物理|概率|统计|概率统计|时间序列|随机过程|布朗运动|ito|伊藤|优化|线性代数|矩阵|微观结构|经济物理|金融数学|量化数学|market microstructure|stochastic process|time series|optimization)/iu.test(
      normalized,
    );
  const asksAuditOnly =
    /(有没有|到底|是不是|还是|卡住|卡在哪|只是|装样子|完成了|失败了|真的|了吗|了吗\?|吗\?|where|whether|did it|status|running|completed|blocked)/u.test(
      normalized,
    );
  const isAgentOrPlatformLearning =
    /(金融智能体|finance agent|agentic finance|智能体|agent platform|agent框架|agent 框架|开源项目|repo|github|同类|同行|竞品|peer|competitor)/u.test(
      normalized,
    );
  const hasConcreteFinanceMethod =
    /(etf|指数|index|大类资产|资产配置|持仓|组合|portfolio|基本面|fundamental|技术面|technical|日频|择时|timing|风控|risk control|风险控制|回撤|drawdown|仓位|position sizing|筛股|选股|行业|板块|财报|估值|valuation|量化|quant|因子|factor|策略|strategy|regime|宏观|利率|信用|credit|流动性|liquidity|金融文章|finance article)/u.test(
      normalized,
    );
  if (isAgentOrPlatformLearning && !hasConcreteFinanceMethod) {
    return false;
  }
  if (hasExplicitPipelineExecutionCue && hasFinanceDomain) {
    return true;
  }
  return (
    hasLearningIntent &&
    hasFinanceDomain &&
    (hasPipelineCue || hasFinanceMethodKnowledgeCue) &&
    !asksAuditOnly
  );
}

export function looksLikeGitHubProjectCapabilityIntakeAsk(text: string): boolean {
  const normalized = normalizeFeishuIntentText(text);
  const hasGitHubProjectCue =
    /(github|repo|repository|开源|开源项目|热榜|trending|star榜|榜单|同类项目|同行项目|竞品项目|别人家的项目|热门项目)/u.test(
      normalized,
    );
  const hasCapabilityCue =
    /(功能|能力|feature|capability|做法|架构|设计|模块|雏形|已有|内部有没有|加进去|接进来|吸收|内化|借鉴|迁移|复用|适合我们|值得学|值得吸收|值得加)/u.test(
      normalized,
    );
  const hasIntakeIntent =
    /(看|看看|查|搜|找|学|学习|审阅|对比|判断|评估|识别|加|接|吸收|内化|能不能|有没有|怎么能|怎么把)/u.test(
      normalized,
    );
  const asksForDirectInstallOrExecution =
    /(直接安装|马上安装|自动安装|clone.*run|克隆.*运行|执行.*仓库|跑.*仓库代码)/u.test(normalized);
  return (
    hasGitHubProjectCue && hasCapabilityCue && hasIntakeIntent && !asksForDirectInstallOrExecution
  );
}

export function looksLikeFinanceLearningMaintenanceAsk(text: string): boolean {
  const normalized = normalizeFeishuIntentText(text);
  const hasMaintenanceDirective =
    /(维护|维护好|管好|整理|梳理|收敛|加固|加强|强化|补强|修补|修好|接上|接起来|保养|盘点|清理|归拢|沉淀|maintain|harden|strengthen|consolidate|keep.*clean|clean.*up)/u.test(
      normalized,
    );
  const hasPriorLearningCue =
    /(之前|过去|已经|已有|现有|内部|前面|前几天|最近|上次|那批|那些|做了很多|落下|落盘|沉淀|artifact|artifacts|资产|管线|pipeline|候选|candidate|capability|能力)/u.test(
      normalized,
    );
  const hasFinanceLearningCue =
    /((金融|finance|股市|股票|美股|a股|港股|etf|指数|index|大类资产|major asset|持仓|portfolio|基本面|fundamental|技术面|technical|日频|风控|risk control|风险控制|策略|strategy).{0,18}(学习|learn|能力|capability|管线|pipeline|资产|artifact|artifacts|候选|candidate|lesson|规则|rule)|(学习|learn|能力|capability|管线|pipeline|资产|artifact|artifacts|候选|candidate|lesson|规则|rule).{0,18}(金融|finance|股市|股票|美股|a股|港股|etf|指数|index|大类资产|major asset|持仓|portfolio|基本面|fundamental|技术面|technical|日频|风控|risk control|风险控制|策略|strategy))/u.test(
      normalized,
    );
  const asksAuditOnly =
    /(有没有|到底|是不是|还是|卡住|卡在哪|只是|装样子|完成了|失败了|真的|了吗|了吗\?|吗\?|where|whether|did it|status)/u.test(
      normalized,
    );
  return hasMaintenanceDirective && hasPriorLearningCue && hasFinanceLearningCue && !asksAuditOnly;
}

export function looksLikeLearningCapabilityLarkCommandAsk(text: string): boolean {
  const normalized = normalizeFeishuIntentText(text);
  const hasLearningCapabilityCue =
    /(学习能力|学习管线|学习系统|学习资产|learning capability|learning capabilities|learning pipeline|learning command|learning_command|内部学习|以前的学习|之前的学习|过去的学习|已有学习|现有学习)/u.test(
      normalized,
    );
  const hasHardeningDirective =
    /(收紧|收敛|加强|强化|补强|维护|维护好|修补|修好|接上|连上|接起来|连起来|打通|做实|做稳|harden|strengthen|tighten|connect|wire)/u.test(
      normalized,
    );
  const hasLarkInterfaceCue =
    /(lark|feishu|飞书|语言接口|对话接口|接口命令|接口|命令|command|commands|自然语言|语义|语言能力|对话理解|分类干活|surface|routing|路由)/u.test(
      normalized,
    );
  const asksStatusOnly =
    /(有没有|现在.*吗|到底|是不是|状态|进度|还在跑|卡住|卡在哪|status|running|completed|blocked)/u.test(
      normalized,
    );
  return (
    hasLearningCapabilityCue && hasHardeningDirective && hasLarkInterfaceCue && !asksStatusOnly
  );
}

export function looksLikeStrategicLearningAsk(text: string): boolean {
  const normalized = normalizeFeishuIntentText(text);
  if (
    looksLikeLearningInternalizationAuditAsk(normalized) ||
    looksLikeLearningWorkflowAuditAsk(normalized)
  ) {
    return false;
  }
  const hasLearningIntent =
    /(去学|学一下|学学|学习|去读|读一下|看看|看一下|去看|去看最近|了解一下|研究一下|研究明白|搞懂|内化|总结|搜一下|搜索一下|查一下|去查|去搜|去偷|偷来|偷点)/u.test(
      normalized,
    );
  const hasExternalLearningSource =
    /(google|web|网上|互联网|搜索|search|github|repo|开源|开源项目|open source|文章|paper|论文|arxiv|博客|blog|文档|docs|资料|材料|source|sources|同类|同行|竞品|别人|别家|peer|peers|competitor|competitors|benchmark|参考对象|外部参照)/u.test(
      normalized,
    );
  const hasSourceDirectedLearning =
    /(google|web|网上|互联网|github|repo|开源|open source|文章|paper|论文|arxiv|博客|blog|文档|docs|资料|材料|同类|同行|竞品|别人|别家|peer|peers|competitor|competitors|benchmark|参考对象|外部参照).{0,16}(学|搜|查|看|读|筛|借鉴|参考|怎么做|做法|方案)|(?:去|到|从|找).{0,16}(google|web|网上|互联网|github|repo|开源|open source|文章|paper|论文|arxiv|博客|blog|文档|docs|资料|材料|同类|同行|竞品|别人|别家|peer|peers|competitor|competitors|benchmark|参考对象|外部参照)/u.test(
      normalized,
    );
  const hasStrategicLearningTopic =
    /(llm|large language model|大语言模型|金融智能体|finance agent|agentic finance|agent platform|智能体平台|同类agent|同类 agent|其他agent|其他 agent|别人家的 agent|agent 圈子|agent圈子|agent 圈|agent圈|智能体圈|记忆|memory|workflow|工作流|研究流程|风控|risk control|策略|strategy|openclaw|lobster)/u.test(
      normalized,
    );
  const hasTimeboxCue =
    /(半个?小时|一个小时|一小时|两个小时|两小时|二小时|\d+(?:\.\d+)?\s*个?\s*小时|\d+(?:\.\d+)?\s*分(?:钟)?|\d+(?:\.\d+)?\s*h(?:our)?s?\b|\d+(?:\.\d+)?\s*m(?:in(?:ute)?s?)?\b)/u.test(
      normalized,
    );
  const hasInternalizationCue =
    /(值得学|值得记住|值得内化|内化|留下|只留下|筛出来|筛选|有用的|可复用|复用|规则|启发|自我提升|学完告诉我|学完说人话总结|会改你以后的做法|改变你以后怎么工作|能改|改你以后做法|改你手法|改你工作流|别做.*综述|不要做.*综述|别复述|不要复述|别做分享会|不要做分享会|少犯错)/u.test(
      normalized,
    );
  return (
    looksLikeSourceCoverageScopeAsk(normalized) ||
    ((hasLearningIntent || hasSourceDirectedLearning) &&
      (hasExternalLearningSource || hasStrategicLearningTopic) &&
      (hasInternalizationCue || (hasTimeboxCue && hasStrategicLearningTopic)))
  );
}

export function looksLikeLearningInternalizationAuditAsk(text: string): boolean {
  const normalized = normalizeFeishuIntentText(text);
  const hasLearningHistoryCue =
    /(最近学的|最近吸收的|最近看的|最近读的|最近读的那些|最近的 openclaw 更新|最近的智能体更新|之前学的|学过的|上次学的那些花活|前几天读的|前几天读那堆东西|前阵子学的|前阵子学过的东西|前阵子补的记忆那套|最近开源里学的|最近论文里学的|最近学的那堆 agent 招数|那些长期记忆玩意儿|学完到底|最近学进规矩的|最近学进去的规矩)/u.test(
      normalized,
    );
  const hasInternalizationAuditCue =
    /(有没有内化|内化成|变成可复用规则|可复用规则|复用规则|真的有用|到底有没有用|别给我做总结秀|别做总结秀|不是做总结|别给我讲总结|值不值得留下|有没有沉淀成规则|沉淀成了哪些.*复用.*规则|以后会复用的规则|嘴上热闹|会改你以后做法|会改你以后手法|进规矩了没|进了你以后干活的规矩|学进规矩|学进去的规矩|明确扔掉|明确丢掉|扔掉的两条|丢掉的两条|扔掉的废话|有没有进长期记忆|留下啥了|过眼云烟|成果展|改掉你老毛病|忘回去了|进总线了|边上堆垃圾|改掉你以前那套坏习惯)/u.test(
      normalized,
    );
  return hasLearningHistoryCue && hasInternalizationAuditCue;
}

export function looksLikeLearningWorkflowAuditAsk(text: string): boolean {
  const normalized = normalizeFeishuIntentText(text);
  const hasLearningWorkflowCue =
    /(后台自动学习|自动学习后台|自动学习这条后台链|后台那条学习链|那条后台学习|昨天让你学的东西|昨天学的东西|前天让你学那个|前天让你学的|前天学的东西|前几天让你补的那堆|最近学的 agent 更新|最近学的智能体更新|最近学的 openclaw 更新|最近学的那堆开源玩意儿|学的东西)/u.test(
      normalized,
    );
  const hasAuditCue =
    /(卡住|卡在哪|写进记忆|写进长期记忆|写进脑子|进长期记忆|进记忆|只是生成了报告|只是出了报告|只是多了几份文件|躺在 report 里|装样子|改变你自己的行为|改变你以后怎么工作|改了你后台干活|后台干活|完成了|失败了|假装在跑|真的进长期记忆|有没有真的进长期记忆|死过机|续上了|装没事|装作啥事没有|半路断过|断过|没报|自己断过又没报|没改|没落账|真落账|文件看着多|只会留痕|留痕)/u.test(
      normalized,
    );
  return hasLearningWorkflowCue && hasAuditCue;
}

export function looksLikeCorrectionCarryoverAsk(text: string): boolean {
  const normalized = normalizeFeishuIntentText(text);
  const hasRecentAnswerCue =
    /(刚才|刚刚|上面|上一条|上条|那句|这句|那条|这条|那个回答|这个回答|你刚才|你刚刚|你上面|你上一条|你那句|你这句|这次|上次)/u.test(
      normalized,
    );
  const hasCarryoverCue =
    /(以后|下次|以后遇到|下次遇到|记住|记下来|记成规则|规则|规矩|别再犯|不要再犯|改掉|改你以后|改你以后做法|改你工作流|变成规则)/u.test(
      normalized,
    );
  const hasCorrectionCue =
    /(不对|错了|说错|答错|理解错|误解|搞错|太满|说太死|说死|没证据|证据不够|没有确认|没确认|没验证|未验证|过度承诺|高报|低报|别这样|不要这样|别再这样|下次别|以后别|不要再|别把.*说成|不要把.*说成)/u.test(
      normalized,
    );
  const hasCorrectionDirective = /(纠正|修正|校正|复盘|错题|反馈|改掉|记住|记下来)/u.test(
    normalized,
  );
  return (hasCorrectionCue || hasCorrectionDirective) && (hasRecentAnswerCue || hasCarryoverCue);
}

export function looksLikeSourceGroundingAsk(text: string): boolean {
  const normalized = normalizeFeishuIntentText(text);
  const hasCurrentClaimCue =
    /(这话|这句话|这句|这条|这个结论|那个结论|这个判断|那个判断|刚才|刚刚|上面|上一条|你刚才|你刚刚|你上面|你说的|你这个说法|你那个说法|你这判断|你那判断|your claim|that claim|this claim)/u.test(
      normalized,
    );
  const hasSourceCue =
    /(来源|出处|源|source|sources|citation|cite|引用|链接|link|依据|根据|证据|evidence|凭什么|哪来的|哪里来的|从哪来|从哪里来|确认过|核过|验证过|查过|verified|confirmed|grounded)/u.test(
      normalized,
    );
  const hasFabricationCue =
    /(编的|瞎编|幻觉|hallucination|hallucinated|猜的|臆测|臆造|没源|无源|没出处|没证据|没验证|未验证|没确认|未确认|说不知道|标未知|别编|不要编|别猜|不要猜|别说死|不要说死)/u.test(
      normalized,
    );
  const asksAudit =
    /(吗|么|是不是|有没有|还是|哪|哪里|从哪|凭什么|给我|说清楚|标出来|说不知道|标未知|别编|不要编|show|where|what|is it|did you|prove|proof|source)/u.test(
      normalized,
    );
  return (
    (hasCurrentClaimCue && (hasSourceCue || hasFabricationCue) && asksAudit) ||
    (hasFabricationCue && hasSourceCue && asksAudit)
  );
}

export function looksLikeExplicitResearchLineContinuationAsk(text: string): boolean {
  const normalized = normalizeFeishuIntentText(text)
    .replace(/[。！？!?.,，]+$/gu, "")
    .trim();
  const hasExplicitLineCue =
    /(当前研究线|当前线|这条研究线|这个研究线|当前这条线|这条线|这个线|上一轮|上轮|刚才那条|刚刚那条|上面那条|前面那条|current research line|current line|this line|that line)/u.test(
      normalized,
    );
  const hasContinuationCue =
    /(继续|接着|往下做|推进|下一步|下一轮|沿着|顺着|按这个|按这条|照着|收敛|别换|不要换|先别换|不换|别开新分支|不要开新分支|别扩新分支|不要扩新分支|别另起炉灶|不要另起炉灶|continue|next step|keep going|stay on|do not switch|don't switch|same line)/u.test(
      normalized,
    );
  const hasSwitchGuard =
    /(别换线|不要换线|先别换线|不换线|别换方向|不要换方向|先别换方向|别开新线|不要开新线|别开新分支|不要开新分支|别扩新分支|不要扩新分支|别另起炉灶|不要另起炉灶|别跳线|不要跳线|don't switch|do not switch|stay on)/u.test(
      normalized,
    );
  const hasLinePreservationCue =
    /(线|方向|上一轮|上轮|刚才那条|刚刚那条|current line|same line|stay on)/u.test(normalized);
  return (
    (hasExplicitLineCue && hasContinuationCue) ||
    (hasSwitchGuard && hasContinuationCue && hasLinePreservationCue)
  );
}

export function looksLikeNegatedScopeCorrectionAsk(text: string): boolean {
  const normalized = normalizeFeishuIntentText(text);
  const hasNegatedScopeCue =
    /(不是让你|不是要你|我不是让你|我不是要你|不是叫你|我不是叫你|不是问你|我不是问|不是这个意思|不是这个方向|不是要这个|别|不要|先别|别给我|不要给我|not asking you to|not asking for|do not|don't|instead of)/u.test(
      normalized,
    );
  const hasTargetPivot =
    /(而是|是让你|是要你|是问|我问的是|我要的是|真正要|只要|只需要|只留下|留下|筛出|筛出来|先说|先给|先标|标出|直接说|重点是|核心是|instead|rather|just tell|only tell|what i mean|what i want)/u.test(
      normalized,
    );
  const hasMisreadCue =
    /(答偏|跑题|理解错|误解|搞错|词不达意|没答到点|方向错|范围错|动作错|bracket|scope|misread)/u.test(
      normalized,
    );
  return (hasNegatedScopeCue && hasTargetPivot) || (hasMisreadCue && hasTargetPivot);
}

export function looksLikeTemporalScopeControlAsk(text: string): boolean {
  const normalized = normalizeFeishuIntentText(text);
  const hasCurrentCue =
    /(现在|当前|今天|今日|此刻|这次|本轮|same-day|today|right now|current|currently|fresh)/u.test(
      normalized,
    );
  const hasHistoricalCue =
    /(刚才|昨天|昨日|上次|上一轮|之前|以前|历史|旧|老|前天|最近七天|最近7天|上周|上个月|last time|previous|prior|historical|old|stale|yesterday|last week)/u.test(
      normalized,
    );
  const hasTemporalSeparationCue =
    /(别拿|不要拿|别用|不要用|别把|不要把|不是|别混|不要混|混成|当成|说成|区分|分开|时间范围|时间框架|新旧|过期|旧证据|旧状态|当前状态|freshness|timeframe|time frame|stale|historical)/u.test(
      normalized,
    );
  const hasMutableTruthCue =
    /(状态|证据|结论|判断|能力|搜索|provider|工具|模型|fallback|学习|session|写入|落盘|失败|成功|receipt|evidence|status|capability|search|model|write|running)/u.test(
      normalized,
    );
  return hasCurrentCue && hasHistoricalCue && (hasTemporalSeparationCue || hasMutableTruthCue);
}

export function looksLikeBoundedPriorityScopeAsk(text: string): boolean {
  const normalized = normalizeFeishuIntentText(text);
  const hasBoundedCue =
    /(只做一个|一次做一个|一个家族|一个方向|一个点|单点|单线|别扩|不要扩|先别扩|不扩|别开新分支|不要开新分支|别扩新分支|不要扩新分支|别发散|不要发散|收敛|最小|smallest|bounded|one thing|one family|single next step|do not branch|don't branch|no branching)/u.test(
      normalized,
    );
  const hasPriorityCue =
    /(优先级|按优先级|下一步|最该|先做|先补|先修|先推进|继续|往下做|最小可验证|可验证|proof|verify|verification|next step|priority|highest priority)/u.test(
      normalized,
    );
  const hasExpansionRiskCue =
    /(新分支|扩新分支|分支|方向|家族|语义|覆盖|提升|改进|实现|patch|scope|branch|family|semantic)/u.test(
      normalized,
    );
  return hasBoundedCue && (hasPriorityCue || hasExpansionRiskCue);
}

export function looksLikeCompletionProofScopeAsk(text: string): boolean {
  const normalized = normalizeFeishuIntentText(text);
  const hasCompletionCue =
    /(做完|完成|完了吗|做成|成了|结束|落盘|写入|保存|receipt|proof|证明|证据|验证|verified|completed|finished|done|finish|complete)/u.test(
      normalized,
    );
  const hasStartOrClaimCue =
    /(开始|启动|在跑|跑着|计划|理解|知道|说了|通知|notice|planned|started|attempted|running|understood|claimed|said)/u.test(
      normalized,
    );
  const hasSeparationCue =
    /(别把|不要把|不是|别当|不要当|区分|分开|说清楚|到底|只是|还是|当成|说成|separate|distinguish|not the same|or only|only start)/u.test(
      normalized,
    );
  const hasAuditCue =
    /(到底|proof|receipt|证据|证明|验证|verified|真的|actually|落盘|写入|artifact|文件|命令|command|检查|check)/u.test(
      normalized,
    );
  return (
    (hasCompletionCue && hasStartOrClaimCue && (hasSeparationCue || hasAuditCue)) ||
    (hasCompletionCue && hasSeparationCue && hasAuditCue)
  );
}

export function looksLikeExecutionAuthorityScopeAsk(text: string): boolean {
  const normalized = normalizeFeishuIntentText(text);
  const hasExecutionCue =
    /(买入|卖出|加仓|减仓|平仓|下单|交易|执行|真实执行|真的执行|操作账户|账户操作|发出去|发送|发布|删掉|删除|同步|改线上|接\s*live|接到\s*live|别接\s*live|不要接\s*live|停止\s*live|暂停\s*live|操控电脑|操作电脑|真实对话测试|lark 测试|别再\s*probe|停止\s*probe|重启|部署|迁移|付款|转账|buy|sell|trade|execute|place order|send it|publish|delete|sync|deploy|restart|migrate|transfer|control the computer|operate lark|operating lark|live probe|stop live|pause live|do not live|do not probe)/u.test(
      normalized,
    );
  const hasAuthorityCue =
    /(权限|授权|允许|批准|可以|没问题|你操控|本次授权|单次授权|当前动作|撤回授权|暂停授权|approval|permission|authority|authorized|unauthorized|permission revoked|authorization revoked|real-world|真实世界|外部系统|live|production|prod|账户|account|broker|brokerage|经纪商|交易权限|execution authority|per[-\s]?action permission)/u.test(
      normalized,
    );
  const hasResearchOnlyCue =
    /(研究[- ]?only|research[- ]?only|只研究|研究建议|建议|模拟|paper trade|paper trading|不能下单|不要下单|别下单|不下单|不执行|别执行|不要执行|别真|不要真|别假装|不要假装|别说已经|不要说已经|别说成|不要说成|不是授权|没有授权|未授权|撤回授权|暂停授权|no execution|not execution|do not execute|don't execute|not authorized|permission revoked|stop authorization)/u.test(
      normalized,
    );
  const hasSeparationCue =
    /(区分|分开|别把|不要把|不是|只是|只能|边界|说清楚|别混|不要混|当成|说成|不等于|仍需|不能继承|不要继承|撤回授权|暂停授权|下次重新|下一轮重新|每次单独|separate|distinguish|boundary|only|not the same|does not mean|still requires|does not carry over|permission revoked|authorization revoked|revoked|ask again|per action)/u.test(
      normalized,
    );
  return (
    hasExecutionCue &&
    (hasAuthorityCue || hasResearchOnlyCue) &&
    (hasResearchOnlyCue || hasSeparationCue)
  );
}

export function looksLikeSourceCoverageScopeAsk(text: string): boolean {
  const normalized = normalizeFeishuIntentText(text);
  const hasExternalSourceCue =
    /(google|web|网上|互联网|搜索|检索|search|github|repo|开源|open source|paper|论文|arxiv|前沿|顶级大学|世界顶级大学|大学|高校|academic|university|college|博客|blog|文档|docs|资料|材料|source|sources|外部来源|外部材料|同类|同行|竞品|peer|peers|competitor|benchmark)/u.test(
      normalized,
    );
  const hasLearningOrResearchCue =
    /(学|学习|去学|去看|看|看看|看一下|读|阅读|研究|查|搜|检索|筛|总结|覆盖|learn|study|research|read|search|scan|review|survey)/u.test(
      normalized,
    );
  const hasCompletenessCue =
    /(查全|搜全|看全|读完|学完|覆盖全|全覆盖|完整覆盖|完整学习|完整检索|所有|全部|尽可能全|足够全|系统性|全面|世界顶级|顶级大学|前沿|frontier|top university|top universities|leading university|leading universities|coverage|complete|full coverage|exhaustive|comprehensive|all sources|everything)/u.test(
      normalized,
    );
  const hasCoverageHonestyCue =
    /(别把|不要把|别说成|不要说成|别假装|不要假装|只能说|说清楚|标出来|标明|说明只读了|只读了|覆盖范围|覆盖面|抽样|样本|只看了|没搜到|搜不到|搜索不可用|检索不可用|能力|capability|limited|sample|sampled|partial|unknown|not exhaustive|not complete|source coverage)/u.test(
      normalized,
    );
  return (
    hasExternalSourceCue &&
    hasLearningOrResearchCue &&
    (hasCompletenessCue || hasCoverageHonestyCue)
  );
}

export function looksLikeDurableMemoryScopeAsk(text: string): boolean {
  const normalized = normalizeFeishuIntentText(text);
  const hasMemoryWriteCue =
    /(记住|记下来|记到|写进|写入|落到|落盘|沉淀|进长期记忆|长期记忆|durable memory|long[-\s]?term memory|memory write|recall|remember|persist|persisted|persistence|记忆|规则|规矩|以后|下次|以后别|下次别)/u.test(
      normalized,
    );
  const hasDurableOrRecallCue =
    /(长期|durable|persistent|persisted|protected|保护|current-research-line|recall order|recallable|召回|下轮|下一轮|以后|下次|未来|跨轮|跨会话|持久|永久|真正记住|真的记住|生效|会用|能召回)/u.test(
      normalized,
    );
  const hasSeparationCue =
    /(别把|不要把|别说成|不要说成|别假装|不要假装|区分|分开|只是|不是|不能|别混|不要混|当成|说成|说清楚|标明|separate|distinguish|do not claim|don't claim|not the same)/u.test(
      normalized,
    );
  const hasArtifactCue =
    /(聊天|上下文|context|临时|ephemeral|artifact|文件|note|receipt|普通文件|summary|protected memory|保护 memory|memory\/current-research-line\.md|接入|没接入|未接入)/u.test(
      normalized,
    );
  return hasMemoryWriteCue && hasDurableOrRecallCue && (hasSeparationCue || hasArtifactCue);
}

export function looksLikeClassifyWorkScopeAsk(text: string): boolean {
  const normalized = normalizeFeishuIntentText(text);
  const hasClassificationCue =
    /(分类|归类|分辨|判别|判断.*类|识别.*类型|先判断|先识别|先分类|按类型|按类别|哪类|什么类型|任务类型|语义家族|工作类型|classify|classification|categorize|category|bucket|intent|intent family|task type|work type)/u.test(
      normalized,
    );
  const hasWorkCue =
    /(干活|做事|处理|执行|回答|路由|分流|派给|走哪个|哪个角色|哪个 surface|surface|角色|专家|lane|工作流|workflow|action|act|route|routing|dispatch|handle|respond|answer|work)/u.test(
      normalized,
    );
  const hasBoundaryCue =
    /(先|再|然后|之后|不要直接|别直接|别猜|不要猜|别硬套|不要硬套|不是按句子|覆盖|全语义|输出合同|证据状态|边界|scope|contract|evidence state|before acting|then act|classify first)/u.test(
      normalized,
    );
  return hasClassificationCue && (hasWorkCue || hasBoundaryCue);
}

export function looksLikeCapabilityClaimScopeAsk(text: string): boolean {
  const normalized = normalizeFeishuIntentText(text);
  const hasCapabilityQuestionCue =
    /(现在|当前|今天|这轮|这次|已经|是不是|能不能|能用吗|能自动|可以用吗|接上|接好了|接\s*live|接到\s*live|接线上|接到线上|跟上|支持没有|支持了吗|可用|可跑|生效|working|available|enabled|supported|wired|connected|live|current|right now|can it|does it|is it)/u.test(
      normalized,
    );
  const hasCapabilityDomainCue =
    /(能力|功能|工具|搜索|检索|provider|模型|接口|lark|feishu|飞书|web|google|memory|recall|自动|自动化|后台|workflow|surface|路由|dispatch|配置|网关|控制室|线上|生产|真实对话|验收|验收短语|验收 phrase|acceptance phrase|build|restart|probe|config|credentials|gateway|control[-\s]?room|capability|tool|search|model|integration|automation|routing|production|prod|live handoff)/u.test(
      normalized,
    );
  const hasTruthBoundaryCue =
    /(别把|不要把|别说成|不要说成|别假装|不要假装|区分|分开|dev[- ]?fixed|live[- ]?fixed|设计目标|目标|计划|本地|local|测试|test|真实|live|production|prod|配置缺失|没配置|未配置|验证|验过|验收|验收短语|验收 phrase|acceptance phrase|命中|未命中|probe|proof|receipt|证据|当前状态|真实状态|stale|过期|unknown|unverified|verified)/u.test(
      normalized,
    );
  return hasCapabilityQuestionCue && hasCapabilityDomainCue && hasTruthBoundaryCue;
}

export function looksLikeClarificationBoundaryScopeAsk(text: string): boolean {
  const normalized = normalizeFeishuIntentText(text);
  const hasAmbiguityCue =
    /(不清楚|不明确|不够明确|没说清|没讲清|缺少|缺了|模糊|歧义|含糊|不知道是哪个|不知道哪条|ambiguous|unclear|underspecified|missing|vague)/u.test(
      normalized,
    );
  const hasSlotCue =
    /(对象|目标|范围|时间窗|时间范围|动作|动作边界|proof|证据|输出|输出合同|surface|角色|任务类型|语义家族|文件|路径|仓位|标的|ticker|scope|target|timeframe|time window|action boundary|output contract|evidence|file|path)/u.test(
      normalized,
    );
  const hasClarificationDirective =
    /(先问|问一句|问我|先澄清|澄清一下|确认一下|先确认|不要硬猜|别硬猜|不要猜|别猜|别直接做|不要直接做|别扩大|不要扩大|ask|clarify|confirm first|ask one|ask a narrow|before acting|do not guess|don't guess)/u.test(
      normalized,
    );
  return hasAmbiguityCue && hasSlotCue && hasClarificationDirective;
}

export function looksLikeInstructionConflictScopeAsk(text: string): boolean {
  const normalized = normalizeFeishuIntentText(text);
  const hasConflictCue =
    /(冲突|矛盾|互斥|不兼容|打架|同时.*不能|不能同时|contradict|contradiction|conflict|incompatible|mutually exclusive)/u.test(
      normalized,
    );
  const hasPositiveActionCue =
    /(继续|写代码|改文件|保存|落盘|搜索|联网|查最新|验证|执行|部署|重启|记住|写进|实现|做|运行|命令|continue|write code|edit file|save|search|browse|verify|execute|deploy|restart|remember|persist|implement|run|command)/u.test(
      normalized,
    );
  const hasNegativeActionCue =
    /(别继续|不要继续|别写|不要写|别改|不要改|别保存|不要保存|别落盘|不要落盘|别联网|不要联网|不联网|别搜索|不要搜索|别验证|不要验证|别执行|不要执行|别部署|不要部署|别重启|不要重启|别记|不要记|不要实现|别实现|别运行|不要运行|不运行|别跑命令|不要跑命令|不跑命令|do not continue|don't continue|do not write|don't write|do not edit|don't edit|without editing|no network|do not browse|don't browse|do not execute|don't execute|do not deploy|don't deploy|do not run|don't run|without running)/u.test(
      normalized,
    );
  const hasResolutionCue =
    /(先指出|先说清|先标|优先级|按优先级|保留|收敛|只执行|最小|先问|别混|不要混|不要硬合并|别硬合并|resolve|prioritize|state the conflict|call out|narrow|smallest compatible)/u.test(
      normalized,
    );
  return (
    (hasConflictCue || (hasPositiveActionCue && hasNegativeActionCue)) &&
    (hasResolutionCue || hasConflictCue)
  );
}

export function looksLikeOutOfScopeBoundaryAsk(text: string): boolean {
  const normalized = normalizeFeishuIntentText(text);
  const hasExclusionCue =
    /(不做|别做|不要做|先不做|这次不做|不碰|别碰|不要碰|不改|别改|不要改|不扩|别扩|不要扩|别开新分支|不要开新分支|不接|别接|不要接|别接\s*live|不要接\s*live|停止\s*live|暂停\s*live|别再\s*probe|停止\s*probe|不纳入|别纳入|out[-\s]?of[-\s]?scope|exclude|excluded|do not include|don't include|do not touch|don't touch|do not expand|don't expand|not in scope|do not live|stop live|pause live|do not probe)/u.test(
      normalized,
    );
  const hasAllowedCue =
    /(只做|只要|只需要|仅做|就做|允许|allowed|in[-\s]?scope|只留下|先做|最小|smallest|only|just|single|one)/u.test(
      normalized,
    );
  const hasBoundaryCue =
    /(边界|范围|scope|excluded work|allowed work|out of scope|不要顺手|别顺手|不要顺便|别顺便|别带上|不要带上|别扩展|不要扩展|live|probe|重启|部署|restart|deploy|next action|下一步|proof|验证)/u.test(
      normalized,
    );
  return hasExclusionCue && (hasAllowedCue || hasBoundaryCue);
}

export function looksLikeHighStakesRiskScopeAsk(text: string): boolean {
  const normalized = normalizeFeishuIntentText(text);
  const hasHighStakesDomainCue =
    /(交易|买入|卖出|买|卖|加仓|减仓|平仓|下单|账户|仓位|止损|止盈|法律|合同|合规|税务|医疗|诊断|用药|删除|删库|生产|线上|部署|重启|付款|转账|broker|brokerage|trade|trading|buy|sell|position|account|legal|law|compliance|tax|medical|diagnosis|medication|delete|drop database|production|deploy|restart|payment|transfer)/u.test(
      normalized,
    );
  const hasActionOrAdviceCue =
    /(该不该|要不要|能不能|现在|直接|帮我|执行|操作|建议|判断|推荐|决定|确认|approve|approval|should i|can i|execute|perform|recommend|decide|confirm|do it|go ahead)/u.test(
      normalized,
    );
  const hasRiskBoundaryCue =
    /(风险|高风险|权限|授权|后果|真实|live|production|prod|证据|验证|proof|fresh|当前|合规|安全|survival|risk|high[-\s]?stakes|authority|permission|authorized|consequence|evidence|verified|safety)/u.test(
      normalized,
    );
  return hasHighStakesDomainCue && (hasActionOrAdviceCue || hasRiskBoundaryCue);
}

export function looksLikeResultShapeScopeAsk(text: string): boolean {
  const normalized = normalizeFeishuIntentText(text);
  const hasOutputDirectiveCue =
    /(只给|只说|先给|先说|开头先|最后给|用表格|按表格|用 checklist|按 checklist|列出来|列出|要列|回执.*列|分成|按.*格式|输出格式|输出合同|不要长文|别长文|不要废话|别废话|一句话|三条|要点|proof|receipt|tested phrase|visible reply|pass\/fail|excluded|in[-\s]?scope|out[-\s]?of[-\s]?scope|next step|tl;dr|table|checklist|bullets|format|output contract|one sentence|short answer)/u.test(
      normalized,
    );
  const hasShapeContentCue =
    /(结论|摘要|要点|证据|proof|风险|边界|测试语句|可见回复|通过|不通过|dev\/live|dev[- ]?fixed|live[- ]?fixed|tested phrase|visible reply|pass\/fail|excluded|in[-\s]?scope|out[-\s]?of[-\s]?scope|下一步|next step|分类|状态|原因|counter|invalidat|action|receipt|verification|summary|table|checklist|bullet)/u.test(
      normalized,
    );
  const hasBrevityOrOrderCue =
    /(只|先|最后|按顺序|顺序|固定|不要|别|短|短一点|简短|compact|brief|concise|first|then|last|only|exactly|no more than)/u.test(
      normalized,
    );
  const hasMultiPartCue = /(.+、.+)|(.*\b(?:and|then)\b.*)|(.*\/.*)|(.*;.*)|(.*；.*)/u.test(
    normalized,
  );
  return hasOutputDirectiveCue && (hasMultiPartCue || (hasShapeContentCue && hasBrevityOrOrderCue));
}

export function looksLikeEvidenceShapeScopeAsk(text: string): boolean {
  const normalized = normalizeFeishuIntentText(text);
  const hasEvidenceCue =
    /(证据|来源|出处|引用|链接|依据|proof|evidence|source|citation|cite|reference|receipt|测试回执|实测回执|探针回执|可见回复|对应回复|同一线程|同一个 chat|验收短语|验收 phrase|acceptance phrase|等价语义|核心槽位|缺失槽位|visible reply|matching reply|tested phrase|same thread|same chat|equivalent semantic|core slots|missing slots|verified|unverified|inferred|推断|缺口|gap)/u.test(
      normalized,
    );
  const hasShapeCue =
    /(格式|表格|标|标明|标出来|分开|按.*输出|测试语句|可见回复|对应回复|验收短语|验收 phrase|acceptance phrase|等价语义|核心槽位|缺失槽位|命中|未命中|chat|thread|message[- ]?time|通过\/不通过|pass\/fail|dev\/live|dev[- ]?fixed|live[- ]?fixed|claim|status|source|gap|verified\/unverified|verified or unverified|证据状态|证据缺口|固定|structure|structured|schema|format|table|separate|slot coverage|matched slots|missing slots)/u.test(
      normalized,
    );
  const hasTruthCue =
    /(别编|不要编|别猜|不要猜|不知道|没证据|没来源|未验证|已验证|推断|verified|unverified|unknown|missing|no evidence|no source|do not invent|don't invent)/u.test(
      normalized,
    );
  return hasEvidenceCue && (hasShapeCue || hasTruthCue);
}

export function looksLikeFailureReportScopeAsk(text: string): boolean {
  const normalized = normalizeFeishuIntentText(text);
  const hasFailureCue =
    /(失败|坏了|挂了|断了|卡住|卡在哪|没成功|没跑通|没完成|无回复|没回复|没有回复|没等到回复|超时|延迟|旧回复|错线程|错 chat|别的 chat|别的线程|不对应|没对上|只发出|只发送|degraded|broken|failed|failure|stuck|blocked|not working|did not work|incomplete|no response|missing reply|timed out|timeout|delayed response|stale reply|wrong thread|wrong chat|not matching|mismatched reply|only sent)/u.test(
      normalized,
    );
  const hasNoFakeSuccessCue =
    /(别装|不要装|别假装|不要假装|别说成功|不要说成功|别报喜|不要报喜|别糊弄|不要糊弄|silent failure|fake success|do not pretend|don't pretend|do not claim success|honest status)/u.test(
      normalized,
    );
  const hasReportShapeCue =
    /(哪里|哪一步|原因|影响|状态|证据|proof|receipt|下一步|修复|降级|失败报告|报告格式|可见回复|通过|不通过|blocked|degraded state|status|blocker|impact|root cause|evidence|next step|repair|report format|visible reply|pass\/fail)/u.test(
      normalized,
    );
  return (hasFailureCue || hasNoFakeSuccessCue) && hasReportShapeCue;
}

export function looksLikeProgressStatusScopeAsk(text: string): boolean {
  const normalized = normalizeFeishuIntentText(text);
  const hasProgressCue =
    /(进度|做到哪|做到哪里|做到哪了|到哪了|现在做到|当前做到|完成到|还剩|剩什么|剩下|下一步是什么|下一步做什么|测试消息|探针|可见回复|live probe|visible reply|status update|progress|where are we|what remains|what is left|next step)/u.test(
      normalized,
    );
  const hasStateSeparationCue =
    /(已完成|正在做|进行中|未开始|阻塞|卡住|还没做|还没开始|只说开始|别只说开始|只发出|只发送|没回复|无回复|超时|started|in progress|done|completed|not started|blocked|remaining|todo|started vs done|only sent|missing reply|no response|timeout)/u.test(
      normalized,
    );
  const hasProofOrNextCue =
    /(proof|证据|receipt|验证|下一步|next action|next step|文件|改了什么|剩余风险|remaining risk)/u.test(
      normalized,
    );
  return hasProgressCue && (hasStateSeparationCue || hasProofOrNextCue);
}

export function looksLikeRoleExpansionScopeAsk(text: string): boolean {
  const normalized = normalizeFeishuIntentText(text);
  const hasRoleCue =
    /(technical|fundamental|ops|knowledge|macro|portfolio|技术|基本面|运营|知识|宏观|组合|角色|专家|specialist|surface|lane|role)/u.test(
      normalized,
    );
  const hasExpansionCue =
    /(expand|展开|展开一下|展开 technical|展开 fundamental|展开 ops|展开 knowledge|切到|转到|进入|派给|只看|细节|detail|drill[-\s]?down|specialist detail|specialist expansion|role switch|switch role)/u.test(
      normalized,
    );
  const hasControlRoomBoundaryCue =
    /(control[-\s]?room|控制室|summary first|先给 summary|先给摘要|先总结|不要抢|别抢|主摘要|main summary|summary|summary-first)/u.test(
      normalized,
    );
  return hasRoleCue && (hasExpansionCue || hasControlRoomBoundaryCue);
}

export function looksLikeBatchQueueScopeAsk(text: string): boolean {
  const normalized = normalizeFeishuIntentText(text);
  const hasBatchCue =
    /(批量|一批|一组|这些都|全都|都做|多个|列表|队列|排队|排个队|任务队列|batch|bulk|queue|queued|list of tasks|multiple tasks)/u.test(
      normalized,
    );
  const hasPriorityCue =
    /(优先级|按优先级|先做|先处理|前两个|前三个|第一个|第二个|排序|排一下|不要并行|别并行|不要同时|别同时|一次一个|一个个|one by one|priority|prioritize|first two|top two|no parallel|do not parallel|one at a time)/u.test(
      normalized,
    );
  const hasStateCue =
    /(queued|done|完成|没完成|剩余|remaining|next item|下一项|下一步|status|状态|proof|receipt)/u.test(
      normalized,
    );
  return hasBatchCue && (hasPriorityCue || hasStateCue);
}

export function looksLikeMarketIntelligencePacketAsk(text: string): boolean {
  const normalized = normalizeFeishuIntentText(text);
  const hasPacketCue =
    /(intelligence packet|market intelligence|市场 intelligence|市场情报包|情报包|研究包|packet|今日市场包|今日情报包)/u.test(
      normalized,
    );
  const hasMarketScopeCue =
    /(etf|指数|index|indices|spy|qqq|iwm|tlt|vix|macro|宏观|rates|利率|dollar|美元|breadth|风险偏好|risk appetite|futures|期货|options|期权|vol|波动率)/u.test(
      normalized,
    );
  const hasCurrentWindowCue = /(今天|今日|same-day|today|盘前|盘后|本日|当前)/u.test(normalized);
  return hasPacketCue && hasMarketScopeCue && hasCurrentWindowCue;
}

export function looksLikeHoldingsRevalidationAsk(content: string): boolean {
  const normalized = normalizeFeishuIntentText(content);
  const hasHoldingsCue = /(持仓|持有|仓位|holding|holdings|position)/u.test(normalized);
  const hasPriorThesisCue =
    /(thesis|旧观点|旧判断|原来的判断|原来那套判断|以前那套 thesis|那套 thesis|原来的逻辑|以前那套逻辑|上次那个结论|上次那套逻辑|上次那套判断|原来拿它的理由|拿它的理由|原来继续拿着的核心理由|继续拿着的核心理由|之前看多它那套根据|之前那份看多理由|上次对[a-z]{2,5}那套说法|上回那个看多的由头|原先撑着继续拿的那几个点|原来扛着不卖那点底气|之前那套继续拿着的根据|之前死扛它那口气|原来那份继续拿着的说法)/u.test(
      normalized,
    );
  const hasRevalidationCue =
    /(之前的持仓分析|持仓分析还成立|原来的持仓分析|之前的判断还成立|原来的判断还成立|还成立吗|还有效吗|还站得住吗|站不站得住|旧判断哪里失效|旧逻辑哪里失效|失效点|之前那套.*失效|上次那套.*失效|是不是已经失效了|现在是不是已经失效了|被市场打脸|不要重新编一套|thesis still holds|still valid|还剩几成|还剩什么|还有几条活着|还有活口没|死了几个|烂掉了|哪句烂了|别重写|就剩嘴硬了|塌了没|还剩几口气|还有没有道理|还有没有骨头)/u.test(
      normalized,
    );
  const hasMarketResearchCue = /(研究|分析|最近|最新|美股|us stocks|us equities|市场)/u.test(
    normalized,
  );
  return (
    (hasHoldingsCue && hasRevalidationCue && hasMarketResearchCue) ||
    (hasPriorThesisCue && hasRevalidationCue)
  );
}

export function looksLikeLearningTimeboxStatusAsk(content: string): boolean {
  const normalized = normalizeFeishuIntentText(content);
  const hasDirectStatusCue =
    /学习状态|学习进度|还在学|还在学习|学到哪|学完了吗|还没学完|timebox status|session status/u.test(
      normalized,
    );
  const hasLearningSessionCue =
    /(学习 session|learning session|限时学习|timebox|当前 session|学习一小时|持续学习|刚才让你学的那条)/u.test(
      normalized,
    );
  const hasSessionLivenessCue =
    /(还活着吗|还在跑吗|还在运行吗|在跑吗|会不会冲掉|冲掉当前 session|冲掉当前的 session)/u.test(
      normalized,
    );
  return hasDirectStatusCue || (hasLearningSessionCue && hasSessionLivenessCue);
}
