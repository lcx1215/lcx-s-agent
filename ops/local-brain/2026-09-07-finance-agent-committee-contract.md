# 金融 Agent 委员会与分层决策权限

## 结论

LCX 现在支持三档金融回答权限：

1. `research_only`：只做研究、风险拆解和证据缺口。
2. `strategy_candidate`：可以输出策略候选、情景、配置逻辑和触发条件，但不能把它写成某个资产的直接买卖动作。
3. `conditional_trade_candidate`：可以输出带条件的买入/卖出候选，包括标的、依据、时间范围、触发条件、风险、失效条件和人工确认边界。

三档都明确 `executionAuthority=none`。真实券商/交易所下单、资金转移、钱包操作不属于子 Agent 权限，也不由候选答案隐式触发。

## 统一事实包

每个金融委员会运行都建立一个 `lcx_finance_committee_context_v1`，包括：

- 用户问题和 `asOf` 时间；
- 每条证据的 id、来源和时间戳；
- 决策权限档位；
- 用户提供的周期、风险预算等约束；
- “所有角色只能使用同一份事实包”的运行指令。

事实包通过 `LogicalAgentPool` 的 `sharedContext` 传给每个角色，并进入 plan fingerprint。因此事实包改变后不能复用旧 checkpoint，恢复也不会把不同时间点的数据混在一起。

## 子 Agent 如何逼近“大 Agent”

系统不声称每个子 Agent 天然等同一个大 Agent，而是把“大 Agent 效果”拆成可验收的委员会目标：

- 数据清洗和财报抽取负责事实层；
- 新闻分类、组合暴露和风险检查负责不同分析面；
- 证据完整性负责来源、字段口径和时间戳；
- 研究草稿负责合成；
- 反方挑战负责证伪；
- 格式整理和最终预审负责保留不确定性、拦截越权。

只有所有必需 lane 完成，委员会结果才是 `committee_candidate`。`equivalenceClaim` 保持 `not_claimed`，必须用同一批金融评测题与单体基线做独立对比后，才能声称达到等效效果。

## 使用方式

本地商业回答管线默认保持旧调用的 `research_only` 兼容行为。需要开启条件交易候选时，显式使用：

```bash
node --import tsx scripts/operator/lcx-commercial-answer-pipeline.ts \
  --finance-mode conditional_trade_candidate \
  --ask "NVDA 现在适合买吗？" \
  --candidate-answer "候选买入 NVDA：只有在财报指引未破坏 thesis 且估值回到风险预算内时才触发；依据是截至时间戳的财报和报价来源。持有周期 1-3 个月，风险是估值压缩和回撤，失效条件是指引下修。仅供审阅，执行前需要人工确认，不自动下单。" \
  --json
```

缺来源、时间戳、风险/失效条件、周期或人工确认边界时，候选仍会被拒绝。
