---
name: trader-strategy-lab
description: "将公开研究者、投资机构与交易者的方法转成可检验的策略和组合风险假说；适用于不同市场、资产与投资期限，默认研究优先、不下单。"
---

# Trader Strategy Lab

把公开方法转成可复核的研究假说和决策包。方法目录只是可扩展的工具箱，不代表穷尽所有市场，也不证明私有信号、当前仓位或稳定收益。

## 按任务读取

- 人物/流派：读 [人物档案](references/practitioners.md)，按来源 ID 查 [来源账本](references/sources.json)。
- 策略设计：读 [方法模块](references/strategy-modules.md)。
- 晋级判断：读 [有效性闸门](references/evaluation-gate.md)；只有问题涉及本地模块成熟度或研究排期时，才参考[模块评分卡](references/method-scorecard.md)，并先核验其日期和最新收据。
- 多方向实证：仅当问题涉及多个方向时，按需查[方向矩阵](references/multi-direction-matrix.md)选取相关项，再查[优先实验](references/priority-experiments.md)中的适用协议。D01–D28 是目录，不是待办队列；完整覆盖须由用户明确要求并有相应证据。
- 数据受阻：读 [沙箱验证](references/sandbox-validation.md)；只验证合同、时点、成本和阻断逻辑。
- 当前环境/新闻：读 [当前情报](references/current-intelligence.md) 和 [新闻更新](references/news-and-refresh.md)，需要时刷新网络。
- 决策输出：用 [决策包](references/decision-packet.md)；AI/科技对象先读人物档案的对应章节。

这些资料是带日期的研究快照。引用当前状态、职位、仓位、规则或市场事实前，先核对来源日期并刷新适用的官方或原始来源；没有新证据就标为历史材料或待核验。人物与机构只是方法样本，不代表完整市场覆盖，也不意味着其监管权限、专有数据、资本规模或执行条件可复制。

## 模式与权限

默认 `research_only`。调用者明确选择时可输出 `strategy_candidate` 或 `conditional_trade_candidate`；所有模式的 `execution_authority` 均为 `none`。本 Skill 不下单、不转账、不操作账户或凭据。各模式的输出条件见[有效性闸门](references/evaluation-gate.md)和[决策包](references/decision-packet.md)。

## 研究范围与证据

先声明市场、司法辖区（如相关）、资产、工具、期限、币种、交易日历、投资者权限与数据覆盖；缺失项写明，不靠默认值补齐。数据检索、时点、来源质量与冲突处理遵循[Finance Data Methodology](../finance-data-methodology/SKILL.md)；研究结论须区分来源事实、当前观察和推导。

每个策略研究都要冻结标的范围、规则、基线、成本、压力和失效条件。不得使用事后修订值、未来成分、同一收盘信号与成交或幸存者样本；代理值必须说明。

## 晋级

阶段为 `method_only → research_candidate → paper_candidate → conditional_trade_candidate`。门槛、停止条件和降级规则统一见[有效性闸门](references/evaluation-gate.md)；本 Skill 不另设一套标准。

## 必查风险

按策略显式处理成本、融资、借券、展期、容量和退出流动性，详见[有效性闸门](references/evaluation-gate.md)。13F 不含完整空头且存在披露滞后；折价不保证收敛；delta 中性仍有 gamma、vega 与 theta 风险；机构执行条件不能默认个人可得。研究阶段晋级不证明模型吸收、持续盈利、账户授权或自动执行部署。
